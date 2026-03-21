const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, '..', '..', 'node_modules', 'adk-typescript', 'dist', 'cli', 'webServer.js');
if (!fs.existsSync(target)) {
  console.error('webServer.js not found:', target);
  process.exit(1);
}

let content = fs.readFileSync(target, 'utf8');
const before = content;

// Prefer project src/cli/browser over node_modules UI
content = content.replace(
  "const possibleUiDirs = [\n        path.join(__dirname, 'browser'), // Regular dist location\n        path.join(__dirname, '..', '..', 'src', 'cli', 'browser'), // Source location\n        path.resolve(process.cwd(), 'src', 'cli', 'browser') // Current working directory\n    ];",
  "const possibleUiDirs = [\n        path.resolve(process.cwd(), 'src', 'cli', 'browser'), // Current working directory\n        path.join(__dirname, 'browser'), // Regular dist location\n        path.join(__dirname, '..', '..', 'src', 'cli', 'browser'), // Source location\n    ];"
);

if (!content.includes("dotenv")) {
  content = content.replace(
    "const express_1 = __importDefault(require(\"express\"));",
    "const express_1 = __importDefault(require(\"express\"));\nconst dotenv = __importDefault(require('dotenv'));\ndotenv.default.config({ path: require('path').resolve(process.cwd(), '.env') });"
  );
}

if (!content.includes("app.post('/api/payment'")) {
  const injection = [
    "// Payment relay endpoint",
    "    app.post('/api/payment', express_1.default.json(), async (req, res) => {",
    "        try {",
    "            const { merchantUrl, productName, txHash, payer, amount, tokenAddress, network, paymentPayload } = req.body || {};",
    "            if (!merchantUrl || !productName || !txHash) {",
    "                return res.status(400).json({ error: 'Missing required fields' });",
    "            }",
    "            const payload = paymentPayload || { txHash, payer, amount, tokenAddress, network };",
    "            const response = await fetch(merchantUrl, {",
    "                method: 'POST',",
    "                headers: { 'Content-Type': 'application/json' },",
    "                body: JSON.stringify({",
    "                    text: `I want to buy ${productName}` ,",
    "                    message: {",
    "                        messageId: `msg-${Date.now()}` ,",
    "                        role: 'user',",
    "                        parts: [{ kind: 'text', text: `I want to buy ${productName}` }],",
    "                        metadata: { x402: { paymentStatus: 'payment-submitted', paymentPayload: payload } },",
    "                    },",
    "                }),",
    "            });",
    "            const data = await response.json();",
    "            return res.json({ ok: response.ok, data });",
    "        } catch (err) {",
    "            return res.status(500).json({ error: err?.message || String(err) });",
    "        }",
    "    });",
    "",
    "    app.get('/api/market-insights', async (req, res) => {",
    "        try {",
    "            const days = Number(req.query?.days || 30);",
    "            const fetchJson = async (url) => {",
    "                const r = await fetch(url);",
    "                if (!r.ok) throw new Error(`HTTP ${r.status}`);",
    "                return r.json();",
    "            };",
    "            let btcPrice = null;",
    "            let priceSource = 'Dexscreener';",
    "            try {",
    "                const search = await fetchJson('https://api.dexscreener.com/latest/dex/search?q=WBTC');",
    "                const pairs = Array.isArray(search?.pairs) ? search.pairs : [];",
    "                const best = pairs.filter((p) => p?.baseToken?.symbol?.toUpperCase() === 'WBTC').sort((a,b)=> (b?.liquidity?.usd||0)-(a?.liquidity?.usd||0))[0];",
    "                if (best?.priceUsd) btcPrice = Number(best.priceUsd);",
    "            } catch (e) {}",
    "            if (!btcPrice) {",
    "                try {",
    "                    priceSource = 'CoinGecko';",
    "                    const cg = await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');",
    "                    btcPrice = cg?.bitcoin?.usd ?? null;",
    "                } catch (e) {}",
    "            }",
    "            let corrSource = 'CoinGecko';",
    "            let correlation = null;",
    "            try {",
    "                const [btc, eth] = await Promise.all([",
    "                    fetchJson(`https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=${days}`),",
    "                    fetchJson(`https://api.coingecko.com/api/v3/coins/ethereum/market_chart?vs_currency=usd&days=${days}`),",
    "                ]);",
    "                const btcPrices = (btc?.prices || []).map((p) => p[1]);",
    "                const ethPrices = (eth?.prices || []).map((p) => p[1]);",
    "                const returns = (arr) => arr.slice(1).map((v, i) => (v - arr[i]) / arr[i]);",
    "                const a = returns(btcPrices); const b = returns(ethPrices);",
    "                const n = Math.min(a.length, b.length);",
    "                if (n > 1) {",
    "                    const mean = (x) => x.reduce((s,v)=>s+v,0)/x.length;",
    "                    const ma = mean(a.slice(0,n)); const mb = mean(b.slice(0,n));",
    "                    let num=0, denA=0, denB=0;",
    "                    for (let i=0;i<n;i++){ const da=a[i]-ma; const db=b[i]-mb; num+=da*db; denA+=da*da; denB+=db*db; }",
    "                    const denom = Math.sqrt(denA*denB);",
    "                    correlation = denom===0?null:num/denom;",
    "                }",
    "            } catch (e) { corrSource='Binance'; }",
    "            return res.json({ btcPrice, priceSource, correlation, corrSource, days });",
    "        } catch (err) {",
    "            return res.status(500).json({ error: err?.message || String(err) });",
    "        }",
    "    });",
    "",
    "    app.get('/api/crypto-news', async (req, res) => {",
    "        try {",
    "            const apiKey = process.env.FINNHUB_API_KEY;",
    "            if (!apiKey) return res.status(500).json({ error: 'FINNHUB_API_KEY missing' });",
    "            const controller = new AbortController();",
    "            const timer = setTimeout(() => controller.abort(), 7000);",
    "            const response = await fetch(`https://finnhub.io/api/v1/news?category=crypto&token=${apiKey}`, { signal: controller.signal });",
    "            clearTimeout(timer);",
    "            const news = await response.json();",
    "            const items = Array.isArray(news) ? news.slice(0, 20) : [];",
    "            return res.json({ items });",
    "        } catch (err) {",
    "            return res.status(500).json({ error: err?.message || String(err) });",
    "        }",
    "    });",
    "",
    "    // Serve UI files"
  ].join("\n");

  content = content.replace("// Serve UI files", injection);
}

if (content !== before) {
  fs.writeFileSync(target, content, 'utf8');
  console.log('✅ Patched webServer.js');
} else {
  console.log('ℹ️ webServer.js already patched');
}
