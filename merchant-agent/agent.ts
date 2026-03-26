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
 * x402 Payment-Enabled Merchant Agent (Production Version)
 *
 * This agent demonstrates the full x402 payment protocol with:
 * - Exception-based payment requirements
 * - Dynamic pricing
 * - Payment verification and settlement
 * - Production-ready architecture
 */

import { LlmAgent as Agent } from 'adk-typescript/agents';
import { LlmRegistry, LiteLlm } from 'adk-typescript/models';
import { createHash } from 'crypto';
import {
  x402PaymentRequiredException,
  PaymentRequirements,
} from 'a2a-x402';

// --- Merchant Agent Configuration ---

// Register LiteLLM to support OpenAI models via OPENAI_API_KEY
LlmRegistry.register(LiteLlm);
// Force-match any model name to LiteLLM (OpenAI, etc.)
(LlmRegistry as any)._register('.*', LiteLlm);

// Validate and load required configuration
if (!process.env.MERCHANT_WALLET_ADDRESS) {
  console.error('❌ ERROR: MERCHANT_WALLET_ADDRESS is not set in .env file');
  console.error('   Please add MERCHANT_WALLET_ADDRESS to your .env file');
  throw new Error('Missing required environment variable: MERCHANT_WALLET_ADDRESS');
}

const WALLET_ADDRESS: string = process.env.MERCHANT_WALLET_ADDRESS;
const NETWORK = process.env.PAYMENT_NETWORK || "base-sepolia";
const USDC_CONTRACT = process.env.USDC_CONTRACT || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';

const PRODUCT_CATALOG = [
  {
    id: "devrel-ebook",
    name: "Developer Relations Ebook",
    description: "A practical guide to modern Developer Relations by dabit3.",
    priceAtomic: "10000", // 0.01 USDC
    link: "https://gist.github.com/dabit3/fd7f4d24ebdda092f6cbbb6a5e57e487",
  },
  {
    id: "market-insights",
    name: "Market Insights",
    description: "Live BTC price + BTC/ETH correlation snapshot.",
    priceAtomic: "1000", // 0.001 USDC
    link: "https://example.com/market-insights",
  },
  {
    id: "crypto-news",
    name: "Crypto News (Top 20)",
    description: "Latest 20 crypto headlines via Finnhub.",
    priceAtomic: "3000", // 0.003 USDC
    link: "https://finnhub.io",
  },
  {
    id: "wallet-search",
    name: "Wallet Search (EVM + Solana)",
    description: "Full holdings report in Yankho format.",
    priceAtomic: "4000", // 0.004 USDC
    link: "https://example.com/wallet-search",
  },
  {
    id: "token-swap",
    name: "Token Swap (Uniswap Mainnet)",
    description: "Swap USDC <-> token on Ethereum mainnet via Uniswap V3. Fee paid on Base Sepolia.",
    priceAtomic: "2000", // 0.002 USDC
    link: "https://app.uniswap.org",
  },
];

console.log(`💼 Merchant Configuration:
  Wallet: ${WALLET_ADDRESS}
  Network: ${NETWORK}
  USDC Contract: ${USDC_CONTRACT}
`);

// --- Helper Functions ---

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchCryptoNews(limit = 20) {
  if (!FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY is missing');
  }
  const news: any[] = await fetchJson(`https://finnhub.io/api/v1/news?category=crypto&token=${FINNHUB_API_KEY}`);
  const items = Array.isArray(news) ? news.slice(0, limit) : [];
  if (!items.length) return 'No news returned.';
  return items.map((item, idx) => {
    const title = item?.headline || 'Untitled';
    const source = item?.source ? ` (${item.source})` : '';
    const url = item?.url || '';
    return `${idx + 1}. ${title}${source}\n${url}`.trim();
  }).join('\n\n');
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
    if (prev > 0) {
      returns.push((curr - prev) / prev);
    }
  }
  return returns;
}

/**
 * Returns a fixed price of 1 USDC for all products
 */
function getProductPrice(productName: string): string {
  const product = PRODUCT_CATALOG.find((item) => item.name.toLowerCase() === productName.toLowerCase());
  if (product) return product.priceAtomic;
  // Default fallback price: 0.01 USDC
  return "10000";
}

// --- Tool Functions ---

/**
 * Get live BTC price and BTC/ETH correlation
 */
async function getMarketInsights(
  params: Record<string, any>,
  context?: any
): Promise<string> {
  const windowDays = Number(params?.days || params?.window || params?.windowDays || 30);

  // Price from Dexscreener (fallback to CoinGecko)
  let priceSource = 'Dexscreener';
  let btcPrice: number | null = null;
  try {
    const search: any = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=WBTC');
    const pairs = Array.isArray(search?.pairs) ? search.pairs : [];
    const best = pairs
      .filter((p: any) => p?.baseToken?.symbol?.toUpperCase() === 'WBTC')
      .sort((a: any, b: any) => (b?.liquidity?.usd || 0) - (a?.liquidity?.usd || 0))[0];
    if (best?.priceUsd) {
      btcPrice = Number(best.priceUsd);
    }
  } catch (error) {
    // ignore and fall back
  }

  if (!btcPrice) {
    try {
      priceSource = 'CoinGecko';
      const cg: any = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
      btcPrice = cg?.bitcoin?.usd ?? null;
    } catch (error) {
      btcPrice = null;
    }
  }

  // Correlation from CoinGecko, fallback to Binance klines
  let corrSource = 'CoinGecko';
  let correlation: number | null = null;
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
  } catch (error) {
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
    } catch (err) {
      correlation = null;
    }
  }

  const priceText = btcPrice ? `$${btcPrice.toFixed(2)}` : 'Unavailable';
  const corrText = correlation === null ? 'Unavailable' : correlation.toFixed(4);

  return `Market snapshot (live):
- BTC price: ${priceText} (source: ${priceSource})
- BTC/ETH correlation (${windowDays}d): ${corrText} (source: ${corrSource})`;
}

/**
 * Get product details and request payment
 * This tool throws x402PaymentRequiredException to trigger the payment flow
 */
async function getProductDetailsAndRequestPayment(
  params: Record<string, any>,
  context?: any
): Promise<void> {
  const productName = params.productName || params.product_name || params;

  console.log(`\n🛒 Product Request: ${productName}`);

  if (!productName || typeof productName !== 'string' || productName.trim() === '') {
    throw new Error("Product name cannot be empty.");
  }

  let product = PRODUCT_CATALOG.find((item) => item.name.toLowerCase() === productName.toLowerCase());
  if (!product) {
    const lower = productName.toLowerCase();
    if (lower.includes('market') || lower.includes('insight')) {
      product = PRODUCT_CATALOG.find((item) => item.id === 'market-insights');
    } else if (lower.includes('news')) {
      product = PRODUCT_CATALOG.find((item) => item.id === 'crypto-news');
    } else if (lower.includes('wallet')) {
      product = PRODUCT_CATALOG.find((item) => item.id === 'wallet-search');
    } else if (lower.includes('swap')) {
      product = PRODUCT_CATALOG.find((item) => item.id === 'token-swap');
    }
  }

  const price = getProductPrice(product?.name || productName);
  const priceUSDC = (parseInt(price) / 1_000_000).toFixed(6);

  console.log(`💰 Price calculated: ${priceUSDC} USDC (${price} atomic units)`);

  // Create payment requirements
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: NETWORK as any,
    asset: USDC_CONTRACT,
    payTo: WALLET_ADDRESS,
    maxAmountRequired: price,
    description: `Payment for: ${product?.name || productName}`,
    resource: product?.link || `https://example.com/product/${productName}`,
    mimeType: "application/json",
    maxTimeoutSeconds: 1200,
    extra: {
      name: "USDC",
      version: "2",
      product: {
        sku: product?.id || `${productName}_sku`,
        name: product?.name || productName,
        version: "1",
      },
    },
  };

  console.log(`💳 Payment required: ${priceUSDC} USDC`);
  console.log(`📡 Throwing x402PaymentRequiredException...`);

  // Throw payment exception - this will be caught by MerchantServerExecutor
  throw new x402PaymentRequiredException(
    `Payment of ${priceUSDC} USDC required for ${productName}`,
    requirements
  );
}

/**
 * Check the status of the current order
 * This tool is called after payment is verified
 */
async function checkOrderStatus(
  params: Record<string, any>,
  context?: any
): Promise<{ status: string; message: string }> {
  console.log('\n📦 Checking Order Status...');

  const requested = String(params?.productName || params?.product || params?.item || '').toLowerCase();
  if (requested.includes('market') || requested.includes('insight')) {
    const insights = await getMarketInsights({ days: 30 });
    return {
      status: "success",
      message: `✅ Payment confirmed! Here are your Market Insights:\n${insights}`,
    };
  }

  if (requested.includes('news')) {
    const news = await fetchCryptoNews(20);
    return {
      status: "success",
      message: `✅ Payment confirmed! Here are the latest 20 crypto headlines:\n${news}`,
    };
  }

  if (requested.includes('wallet')) {
    return {
      status: "success",
      message: `✅ Payment confirmed! Please provide the wallet address (EVM or Solana) you'd like to scan.`,
    };
  }

  const product = PRODUCT_CATALOG.find((item) => item.id === 'devrel-ebook') || PRODUCT_CATALOG[0];

  return {
    status: "success",
    message: `✅ Payment confirmed! Here is your download link for ${product.name}: ${product.link}`
  };
}

// --- Agent Definition ---

export const merchantAgent = new Agent({
  name: "x402_merchant_agent",
  model: "gpt-4o",
  description: "A merchant agent that sells a curated catalog and provides market insights.",
  instruction: `You are a helpful and friendly merchant agent powered by the x402 payment protocol.

**Your Role:**
- You sell a specific catalog of digital products (starting with a Developer Relations Ebook)
- You sell a specific catalog of paid products (ebook + market insights)
- When a user asks what products are available, describe the catalog and pricing
- When a user asks to buy the ebook or market insights, ALWAYS use the 'getProductDetailsAndRequestPayment' tool
- After payment is verified by the system:
  - For the ebook, provide the download link
  - For market insights, provide the latest BTC price + BTC/ETH correlation
- Be professional, friendly, and concise

**Catalog:**
- Developer Relations Ebook — 0.01 USDC
- Market Insights (live BTC price + BTC/ETH correlation) — 0.001 USDC
- Crypto News (latest 20 headlines) — 0.003 USDC
- Wallet Search (EVM + Solana) — 0.004 USDC
- Token Swap (Uniswap Mainnet) — 0.002 USDC

**Critical Rules:**
- ALWAYS call getProductDetailsAndRequestPayment when a user wants to buy the ebook
- If the user asks for unavailable items, gently redirect them to the ebook
- The payment processing happens automatically — you don't need to mention technical details

**Examples:**
- "What products do you have?" → Explain the ebook + market insights and prices
- "I want to buy the Developer Relations Ebook" → Call getProductDetailsAndRequestPayment
- "I want market insights" → Call getProductDetailsAndRequestPayment
- "Can I buy a book?" → Treat it as the Developer Relations Ebook and proceed`,
  tools: [
    getProductDetailsAndRequestPayment,
    checkOrderStatus,
    getMarketInsights,
  ],
});

// Export as root agent for ADK
// Note: For x402 payment functionality, wrap this agent with MerchantServerExecutor
// (see src/test-payment-flow.ts for example)
export const rootAgent = merchantAgent;
