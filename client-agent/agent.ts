//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * x402 Client Agent - Orchestrator agent with payment capabilities
 *
 * This agent can discover and interact with remote agents (like merchants),
 * automatically handling payment flows when required.
 */

import { LlmAgent as Agent } from 'adk-typescript/agents';
import { ToolContext } from 'adk-typescript/tools';
import { LlmRegistry, LiteLlm } from 'adk-typescript/models';
import { LocalWallet } from './src/wallet/Wallet';
import { x402Utils, PaymentStatus } from 'a2a-x402';
import { logger } from './src/logger';
import { ethers } from 'ethers';

// --- Client Agent Configuration ---

// Register LiteLLM to support OpenAI models via OPENAI_API_KEY
LlmRegistry.register(LiteLlm);
// Force-match any model name to LiteLLM (OpenAI, etc.)
(LlmRegistry as any)._register('.*', LiteLlm);

const MERCHANT_AGENT_URL = process.env.MERCHANT_AGENT_URL || 'http://localhost:10000';
const DEFAULT_EBOOK_LINK = 'https://gist.github.com/dabit3/fd7f4d24ebdda092f6cbbb6a5e57e487';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';

logger.log(`🤖 Client Agent Configuration:
  Merchant URL: ${MERCHANT_AGENT_URL}
`);

// Initialize wallet
const wallet = new LocalWallet();
const x402 = new x402Utils();

// State management
interface AgentState {
  sessionId?: string;
  pendingPayment?: {
    agentUrl: string;
    agentName: string;
    requirements: any;
    taskId?: string;
    contextId?: string;
  };
  pendingWalletSearch?: boolean;
  pendingProductName?: string;
}

const state: AgentState = {};

// Helper to ensure we have a session
async function ensureSession(): Promise<string> {
  if (state.sessionId) {
    return state.sessionId;
  }

  // Create a new session
  try {
    const response = await fetch(`${MERCHANT_AGENT_URL}/apps/x402_merchant_agent/users/client-user/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status}`);
    }

    const session = await response.json() as any;
    state.sessionId = session.id;
    logger.log(`✅ Created new session: ${state.sessionId}`);
    return state.sessionId!;
  } catch (error) {
    logger.error('❌ Failed to create session:', error);
    throw error;
  }
}

// --- Tool Functions ---

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function pearsonCorrelation(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  const denom = Math.sqrt(denA * denB);
  return denom === 0 ? null : num / denom;
}

function computeReturns(prices: number[]) {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const curr = prices[i];
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

const EVM_NETWORKS: Record<string, { name: string; rpc: string; explorer: string; native: string; dexscreenerChain: string; coingeckoId: string }> = {
  ethereum: { name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', native: 'ETH', dexscreenerChain: 'ethereum', coingeckoId: 'ethereum' },
  arbitrum: { name: 'Arbitrum', rpc: 'https://arbitrum-one.publicnode.com', explorer: 'https://arbiscan.io', native: 'ETH', dexscreenerChain: 'arbitrum', coingeckoId: 'ethereum' },
  base: { name: 'Base', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org', native: 'ETH', dexscreenerChain: 'base', coingeckoId: 'ethereum' },
  polygon: { name: 'Polygon', rpc: 'https://polygon-bor.publicnode.com', explorer: 'https://polygonscan.com', native: 'MATIC', dexscreenerChain: 'polygon', coingeckoId: 'matic-network' },
  bsc: { name: 'BSC', rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com', native: 'BNB', dexscreenerChain: 'bsc', coingeckoId: 'binancecoin' },
  avalanche: { name: 'Avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', explorer: 'https://snowtrace.io', native: 'AVAX', dexscreenerChain: 'avalanche', coingeckoId: 'avalanche-2' },
};

const POPULAR_TOKENS: Record<string, Array<{ address: string; symbol: string; name: string; decimals: number; isNative?: boolean }>> = {
  ethereum: [
    { address: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, isNative: true },
    { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', name: 'Tether', decimals: 6 },
    { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped Bitcoin', decimals: 8 },
  ],
  arbitrum: [
    { address: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, isNative: true },
    { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
    { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', symbol: 'USDT', name: 'Tether', decimals: 6 },
  ],
  base: [
    { address: 'native', symbol: 'ETH', name: 'Ethereum', decimals: 18, isNative: true },
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  polygon: [
    { address: 'native', symbol: 'MATIC', name: 'Polygon', decimals: 18, isNative: true },
    { address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
  bsc: [
    { address: 'native', symbol: 'BNB', name: 'BNB', decimals: 18, isNative: true },
    { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', symbol: 'USDC', name: 'USD Coin', decimals: 18 },
  ],
  avalanche: [
    { address: 'native', symbol: 'AVAX', name: 'Avalanche', decimals: 18, isNative: true },
    { address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', symbol: 'USDC', name: 'USD Coin', decimals: 6 },
  ],
};

async function rpcCall(rpcUrl: string, method: string, params: any[]) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  const data: any = await res.json();
  if (data?.error) throw new Error(data.error.message || 'RPC error');
  return data?.result;
}

async function fetchTokenPriceFromDexscreener(tokenAddress: string, chain: string) {
  try {
    const data: any = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
    const pairs = (data?.pairs || []).filter((p: any) => p?.chainId === chain && p?.priceUsd);
    if (!pairs.length) return null;
    const best = pairs.sort((a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
    const totalLiquidity = pairs.reduce((sum: number, p: any) => sum + (Number(p?.liquidity?.usd) || 0), 0);
    return {
      price: Number(best.priceUsd) || 0,
      change24h: Number(best.priceChange?.h24) || 0,
      bestPool: best.pairAddress,
      bestDex: best.dexId,
      bestPoolLiquidity: Number(best.liquidity?.usd) || 0,
      totalLiquidity,
      poolCount: pairs.length,
      symbol: best.baseToken?.symbol || best.quoteToken?.symbol,
      name: best.baseToken?.name || best.quoteToken?.name,
    };
  } catch (err) {
    return null;
  }
}

const TOKEN_DB_TTL_MS = 5 * 60 * 1000;
const tokenDbCache: Record<string, { timestamp: number; tokens: any[] }> = {};

async function fetchTokenDatabase(networkKey: string) {
  const cached = tokenDbCache[networkKey];
  if (cached && Date.now() - cached.timestamp < TOKEN_DB_TTL_MS) return cached.tokens;
  const fileMap: Record<string, string> = {
    ethereum: 'ethereum.json',
    arbitrum: 'arbitrum.json',
    base: 'base.json',
    polygon: 'polygon.json',
    bsc: 'bsc.json',
    avalanche: 'avalanche.json',
  };
  const file = fileMap[networkKey];
  if (!file) return [];
  try {
    const url = `https://raw.githubusercontent.com/deagentsai/token_database/main/${file}`;
    const data: any = await fetchJson(url);
    const tokens = Array.isArray(data) ? data : [];
    tokenDbCache[networkKey] = { timestamp: Date.now(), tokens };
    return tokens;
  } catch (err) {
    return [];
  }
}

async function getNativePrice(coinId: string) {
  try {
    const data: any = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`);
    return { price: data?.[coinId]?.usd || 0, change24h: data?.[coinId]?.usd_24h_change || 0 };
  } catch (err) {
    return { price: 0, change24h: 0 };
  }
}

async function getMarketInsightsSnapshot(windowDays = 30) {
  let btcPrice: number | null = null;
  let priceSource = 'Dexscreener';
  try {
    const search: any = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=WBTC');
    const pairs = Array.isArray(search?.pairs) ? search.pairs : [];
    const best = pairs
      .filter((p: any) => p?.baseToken?.symbol?.toUpperCase() === 'WBTC')
      .sort((a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
    if (best?.priceUsd) btcPrice = Number(best.priceUsd);
  } catch (err) {
    // ignore
  }

  if (!btcPrice) {
    try {
      priceSource = 'CoinGecko';
      const cg: any = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      btcPrice = cg?.bitcoin?.usd ?? null;
    } catch (err) {
      btcPrice = null;
    }
  }

  let correlation: number | null = null;
  let corrSource = 'CoinGecko';
  try {
    const [btc, eth]: any[] = await Promise.all([
      fetchJson(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${windowDays}`),
      fetchJson(`https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=${windowDays}`),
    ]);
    const btcPrices = (btc?.prices || []).map((p: any) => p[1]);
    const ethPrices = (eth?.prices || []).map((p: any) => p[1]);
    const btcReturns = computeReturns(btcPrices);
    const ethReturns = computeReturns(ethPrices);
    correlation = pearsonCorrelation(btcReturns, ethReturns);
  } catch (err) {
    corrSource = 'Binance';
    try {
      const [btc, eth]: any[] = await Promise.all([
        fetchJson(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=${windowDays}`),
        fetchJson(`https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=1d&limit=${windowDays}`),
      ]);
      const btcPrices = btc.map((k: any) => Number(k[4]));
      const ethPrices = eth.map((k: any) => Number(k[4]));
      const btcReturns = computeReturns(btcPrices);
      const ethReturns = computeReturns(ethPrices);
      correlation = pearsonCorrelation(btcReturns, ethReturns);
    } catch (err2) {
      correlation = null;
    }
  }

  const priceText = btcPrice ? `$${btcPrice.toFixed(2)}` : 'Unavailable';
  const corrText = correlation === null ? 'Unavailable' : correlation.toFixed(4);

  return `Market Insights (live):\n- BTC price: ${priceText} (source: ${priceSource})\n- BTC/ETH correlation (${windowDays}d): ${corrText} (source: ${corrSource})`;
}

/**
 * Send a message to a remote merchant agent using ADK protocol
 */
async function runWalletSearch(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  if (!state.pendingWalletSearch) {
    return 'Wallet search is not active. Please purchase Wallet Search first.';
  }

  const address = typeof params === 'string' ? params : (params.address || params.wallet || params.params || params);
  if (!address || typeof address !== 'string') {
    return 'Please provide a valid wallet address.';
  }

  const addr = address.trim();
  const isEvm = /^0x[a-fA-F0-9]{40}$/.test(addr);
  const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
  if (!isEvm && !isSol) {
    return 'Address format not recognized. Provide an EVM (0x...) or Solana address.';
  }

  let report = '';

  if (isSol) {
    // Solana balances
    let solBalance = 0;
    let solPrice = 0;
    let solChange = 0;
    try {
      const solPriceData: any = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true');
      solPrice = solPriceData?.solana?.usd || 0;
      solChange = solPriceData?.solana?.usd_24h_change || 0;
    } catch (err) {
      solPrice = 0;
      solChange = 0;
    }

    const heliusRpc = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : '';
    const rpcEndpoints = [heliusRpc, 'https://solana-rpc.publicnode.com'].filter(Boolean);
    for (const rpc of rpcEndpoints) {
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [addr] })
        });
        const data: any = await res.json();
        if (data?.result?.value !== undefined) {
          solBalance = data.result.value / 1e9;
          break;
        }
      } catch (err) {
        // ignore
      }
    }

    const solValue = (solBalance * solPrice);
    const tokens: Array<{ symbol: string; mint: string; balance: string; value: string; chain: string; priced: boolean }> = [];
    tokens.push({ symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', balance: solBalance.toString(), value: solValue ? solValue.toFixed(2) : '0', chain: 'Solana', priced: solPrice > 0 });

    // SPL tokens
    try {
      const tokenRes = await fetch(heliusRpc || 'https://solana-rpc.publicnode.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [addr, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]
        })
      });
      const tokenData: any = await tokenRes.json();
      const accounts = tokenData?.result?.value || [];
      for (const account of accounts.slice(0, 25)) {
        const info = account?.account?.data?.parsed?.info;
        const mint = info?.mint;
        const amount = info?.tokenAmount?.uiAmountString;
        if (!mint || !amount || Number(amount) === 0) continue;
        const priceData = await fetchTokenPriceFromDexscreener(mint, 'solana');
        const price = priceData?.price || 0;
        const value = Number(amount) * price;
        tokens.push({
          symbol: priceData?.symbol || mint.slice(0, 6),
          mint,
          balance: amount,
          value: price ? value.toFixed(2) : 'N/A',
          chain: 'Solana',
          priced: price > 0,
        });
      }
    } catch (err) {
      // ignore
    }

    const pricedTotal = tokens.filter(t => t.value !== 'N/A').reduce((sum, t) => sum + Number(t.value), 0);
    const unpricedCount = tokens.filter(t => t.value === 'N/A').length;

    report = `Executive summary\n• Wallet on Solana\n• Holds SOL + ${tokens.length - 1} SPL tokens\n• ${unpricedCount} tokens unpriced\n• Known priced total: $${pricedTotal.toFixed(2)}\n\n─── Wallet — Solana\nAddress: ${addr}\n| Token | Mint | Quantity | Est. USD | Chain |\n| ---- | ---- | ---- | ---- | ---- |\n${tokens.map(t => `| ${t.symbol} | ${t.mint} | ${t.balance} | ${t.value === 'N/A' ? 'N/A' : `$${t.value}`} | ${t.chain} |`).join('\n')}\n\nWallet total (known-priced only): $${pricedTotal.toFixed(2)}\n\nSources used\n• Solana RPC (getBalance, getTokenAccountsByOwner)\n• Dexscreener token endpoint\n• CoinGecko SOL/USD\n\nCaveats / confidence\n• High confidence: chain detection + raw token balances\n• Medium confidence: Solana token pricing for low-liquidity tokens\n• Some tokens had no discovered market pairs, so USD value is unknown.`;
  }

  if (isEvm) {
    const chainResults: Array<{ chain: string; tokens: any[]; total: number }> = [];

    for (const [key, cfg] of Object.entries(EVM_NETWORKS)) {
      const tokens: any[] = [];
      // native balance
      let nativeBal = 0;
      try {
        const balHex = await rpcCall(cfg.rpc, 'eth_getBalance', [addr, 'latest']);
        nativeBal = Number(ethers.formatEther(balHex || '0x0'));
      } catch (err) {
        nativeBal = 0;
      }
      const nativePrice = await getNativePrice(cfg.coingeckoId);
      if (nativeBal > 0) {
        tokens.push({
          symbol: cfg.native,
          contract: 'native',
          balance: nativeBal.toString(),
          value: (nativeBal * nativePrice.price).toFixed(2),
          chain: cfg.name,
        });
      }

      const builtIn = POPULAR_TOKENS[key] || [];
      const onlineDb = await fetchTokenDatabase(key);
      const merged = new Map<string, { address: string; symbol: string; name: string; decimals: number }>();

      for (const t of builtIn) {
        if (!t.address || t.address === 'native') continue;
        merged.set(t.address.toLowerCase(), { address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals });
      }
      for (const t of onlineDb) {
        if (!t?.address || t.address === 'native') continue;
        if (!merged.has(t.address.toLowerCase())) {
          merged.set(t.address.toLowerCase(), {
            address: t.address,
            symbol: t.symbol || t.address.slice(0, 6),
            name: t.name || 'Token',
            decimals: Number.isFinite(t.decimals) ? t.decimals : 18,
          });
        }
      }

      const tokenList = Array.from(merged.values()).slice(0, 220);
      for (const token of tokenList) {
        try {
          const iface = new ethers.Interface(['function balanceOf(address owner) view returns (uint256)']);
          const data = iface.encodeFunctionData('balanceOf', [addr]);
          const result = await rpcCall(cfg.rpc, 'eth_call', [{ to: token.address, data }, 'latest']);
          const bal = Number(ethers.formatUnits(result || '0x0', token.decimals));
          if (bal > 0) {
            const priceData = await fetchTokenPriceFromDexscreener(token.address, cfg.dexscreenerChain);
            const price = priceData?.price || 0;
            tokens.push({
              symbol: token.symbol,
              contract: token.address,
              balance: bal.toString(),
              value: price ? (bal * price).toFixed(2) : 'N/A',
              chain: cfg.name,
            });
          }
        } catch (err) {
          // ignore
        }
      }

      const chainTotal = tokens.reduce((sum, t) => sum + (t.value === 'N/A' ? 0 : Number(t.value)), 0);
      if (tokens.length > 0) {
        chainResults.push({ chain: cfg.name, tokens, total: chainTotal });
      }
    }

    const overallTotal = chainResults.reduce((sum, c) => sum + c.total, 0);
    const tables = chainResults.map(c => {
      const rows = c.tokens.map(t => `| ${t.symbol} | ${t.contract} | ${t.balance} | ${t.value === 'N/A' ? 'N/A' : `$${t.value}`} | ${t.chain} |`).join('\n');
      return `─── Wallet — ${c.chain}\nAddress: ${addr}\n| Token | Contract | Quantity | Est. USD | Chain |\n| ---- | ---- | ---- | ---- | ---- |\n${rows}\n\n${c.chain} total: $${c.total.toFixed(2)}`;
    }).join('\n\n');

    report = `Executive summary\n• Wallet is an EVM address\n• Chains scanned: ${chainResults.map(c => c.chain).join(', ') || 'none'}\n• Combined known total: $${overallTotal.toFixed(2)}\n\n${tables}\n\nSources used\n• Public RPCs (Ethereum, Arbitrum, Base, Polygon)\n• Dexscreener token endpoint\n• CoinGecko native prices\n\nCaveats / confidence\n• High confidence: chain detection + native balances\n• Medium confidence: token pricing and limited token list\n• This report scans popular tokens only; obscure tokens may be missing.`;
  }

  state.pendingWalletSearch = false;
  return report;
}

async function sendMessageToMerchant(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  // Handle both direct string and object with message/params field
  let message = typeof params === 'string' ? params : (params.message || params.params || params);
  if (typeof message === 'string') {
    const lower = message.toLowerCase();
    if (lower.includes('crypto news') || (lower.includes('news') && lower.includes('crypto'))) {
      message = 'I want to buy Crypto News';
    }
    if (lower.includes('wallet search') || (lower.includes('wallet') && lower.includes('search'))) {
      message = 'I want to buy Wallet Search';
    }
  }

  logger.log(`\n📤 Sending message to merchant: "${message}"`);

  try {
    // Ensure we have a session
    const sessionId = await ensureSession();

    // Make real HTTP request to merchant server using ADK /run endpoint
    const response = await fetch(`${MERCHANT_AGENT_URL}/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appName: 'x402_merchant_agent',
        userId: 'client-user',
        sessionId: sessionId,
        newMessage: {
          role: 'user',
          parts: [{ text: String(message) }],
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`❌ Merchant server error (${response.status}): ${errorText}`);
      return `Sorry, I couldn't connect to the merchant. The server returned an error: ${response.status}. Make sure the merchant server is running at ${MERCHANT_AGENT_URL}`;
    }

    const events = await response.json() as any[];
    logger.log(`✅ Received ${events.length} events from merchant`);
    logger.log('📊 All events:', JSON.stringify(events, null, 2));

    // ADK returns an array of events - process them
    // CRITICAL: Check ALL events for payment requirements FIRST, then process text responses
    // This is because the merchant sends both the agent's text response AND the payment requirement

    // First pass: Look for payment requirements in ANY event
    for (const event of events) {
      logger.log(`\n🔍 Processing event (pass 1 - payment check):
        - author: ${event.author || 'unknown'}
        - errorCode: ${event.errorCode || 'none'}
        - has content: ${!!event.content}
        - has errorData: ${!!event.errorData}`);

      // Check if this is an x402 payment exception
      if (event.errorCode && event.errorCode === 'x402_payment_required') {
        logger.log('🎯 Found payment requirement event!');
        const paymentReqs = event.errorData?.paymentRequirements;
        logger.log(`Payment requirements data:`, JSON.stringify(paymentReqs, null, 2));

        if (paymentReqs && paymentReqs.accepts && paymentReqs.accepts.length > 0) {
          const paymentOption = paymentReqs.accepts[0];
          const price = BigInt(paymentOption.maxAmountRequired);
          const priceUSDC = (Number(price) / 1_000_000).toFixed(6);
          const productName = paymentOption.extra?.product?.name || 'product';

          // Store payment requirements in state
          state.pendingPayment = {
            agentUrl: MERCHANT_AGENT_URL,
            agentName: 'merchant_agent',
            requirements: paymentReqs,
            taskId: event.invocationId,
            contextId: event.invocationId,
          };
          state.pendingProductName = productName;

          logger.log(`💰 Payment required: ${priceUSDC} USDC for ${productName}`);

          return `The merchant agent responded! They're selling ${productName} for ${priceUSDC} USDC.

**Payment Details:**
- Product: ${productName}
- Price: ${priceUSDC} USDC (${price.toString()} atomic units)
- Network: ${paymentOption.network}
- Payment Token: ${paymentOption.extra?.name || 'USDC'}
- Merchant Address: ${paymentOption.payTo}

- Merchant Address: ${paymentOption.payTo}

Would you like to proceed with this payment?`;
        }
      }
    }

    // Second pass: No payment requirements found, look for regular text responses
    logger.log('\n📝 No payment requirements found, checking for text responses...');
    for (const event of events) {
      if (event.content && event.content.parts) {
        const textParts = event.content.parts
          .filter((p: any) => p.text)
          .map((p: any) => p.text)
          .join('\n');
        logger.log(`Text content: "${textParts}"`);
        if (textParts) {
          logger.log('✅ Returning text content from merchant');
          return `Merchant says: ${textParts}`;
        }
      }
    }

    // If we got a response but no payment requirements or message, return generic success
    return `I contacted the merchant, but received an unexpected response format. Events: ${JSON.stringify(events)}`;

  } catch (error) {
    logger.error('❌ Failed to contact merchant:', error);
    if (error instanceof Error) {
      if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
        return `❌ Cannot connect to the merchant server at ${MERCHANT_AGENT_URL}. Please make sure:\n1. The merchant server is running (npm start in merchant-agent directory)\n2. The server is accessible at ${MERCHANT_AGENT_URL}\n\nError: ${error.message}`;
      }
      return `Failed to contact merchant: ${error.message}`;
    }
    return `Failed to contact merchant: ${String(error)}`;
  }
}

/**
 * Confirm and sign a pending payment
 */
async function confirmPayment(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  return 'Payments are processed via MetaMask in the web UI. Please click Connect and confirm there.';
}

/**
 * Cancel a pending payment
 */
async function cancelPayment(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  if (!state.pendingPayment) {
    return 'No pending payment to cancel.';
  }

  logger.log('❌ User cancelled payment.');
  state.pendingPayment = undefined;

  return 'Payment cancelled.';
}

/**
 * Get wallet information
 */
async function getWalletInfo(
  params: Record<string, any>,
  context?: ToolContext
): Promise<string> {
  return `Wallet Address: ${wallet.getAddress()}`;
}

// --- Agent Definition ---

export const clientAgent = new Agent({
  name: 'x402_client_agent',
  model: 'gpt-4o',
  description: 'An orchestrator agent that can interact with merchants and handle payments.',
  instruction: `You are a helpful client agent that assists users in buying products from merchant agents using cryptocurrency payments.

**How you work:**
This is an x402 payment demo. You can help users purchase products from merchant agents using USDC on the Base Sepolia blockchain.

**When users greet you or send unclear messages:**
Introduce yourself and explain what you can do:
- "Hi! I'm a client agent that can help you purchase products using cryptocurrency."
- "I can connect to merchant agents and handle the payment process for you."
- "Try asking: 'What offerings do you have?' or 'I want the Developer Relations Ebook'."
- "Use the Connect button above to see your wallet address and balances."

**When users want to buy something:**
1. Use sendMessageToMerchant to request the product from the merchant
2. The merchant will respond with payment requirements (amount in USDC)
3. Ask the user to confirm: "The merchant is requesting X USDC for [product]. Do you want to proceed?"
4. If user confirms ("yes", "confirm", "ok"), use confirmPayment to sign and submit
5. If user declines ("no", "cancel"), use cancelPayment

**When users ask what products are available:**
- Use sendMessageToMerchant to request the catalog and summarize it for the user
- Ensure the response lists: Developer Relations Ebook (0.01 USDC), Market Insights (0.001 USDC), Crypto News (0.003 USDC), Wallet Search (0.004 USDC)

**When Wallet Search was purchased and the user provides an address:**
- Call runWalletSearch with the address
- Return the report in Yankho’s template

**Important guidelines:**
- ALWAYS explain what you're doing in a friendly, clear way
- When greeting messages arrive, respond warmly and explain your capabilities
- Be transparent about payment amounts before proceeding
- Handle errors gracefully and explain what went wrong
- If the user message doesn't relate to purchasing, kindly redirect them to ask for a product

**Example interactions:**

User: "hello"
You: "Hi! I'm an x402 payment client agent. I can help you buy products from merchants using USDC cryptocurrency. Use the Connect button above to view your wallet address and balances. Try asking: 'What offerings do you have?'"

User: "I want to buy a banana"
You: [Contact merchant, receive requirements]
You: "The merchant is requesting 54.39 USDC for a banana. Would you like to proceed with this payment?"

User: "yes"
You: [Sign and submit payment]
You: "✅ Payment successful! Your banana order has been confirmed!"`,

  tools: [
    sendMessageToMerchant,
    confirmPayment,
    cancelPayment,
    runWalletSearch,
    getWalletInfo,
  ],
});

// Export as root agent for ADK
export const rootAgent = clientAgent;
