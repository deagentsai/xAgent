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

// Inject /api/payment relay endpoint (if not present)
if (!content.includes('app.post(\'/api/payment\'')) {
  content = content.replace(
    "// Serve UI files",
    "// Payment relay endpoint\n    app.post('/api/payment', express_1.default.json(), async (req, res) => {\n        try {\n            const { merchantUrl, productName, txHash, payer, amount, tokenAddress, network, paymentPayload } = req.body || {};\n            if (!merchantUrl || !productName || !txHash) {\n                return res.status(400).json({ error: 'Missing required fields' });\n            }\n            const payload = paymentPayload || {\n                txHash, payer, amount, tokenAddress, network\n            };\n            const response = await fetch(merchantUrl, {\n                method: 'POST',\n                headers: { 'Content-Type': 'application/json' },\n                body: JSON.stringify({\n                    text: `I want to buy ${productName}`,\n                    message: {\n                        messageId: `msg-${Date.now()}`,\n                        role: 'user',\n                        parts: [{ kind: 'text', text: `I want to buy ${productName}` }],\n                        metadata: {\n                            x402: {\n                                paymentStatus: 'payment-submitted',\n                                paymentPayload: payload,\n                            },\n                        },\n                    },\n                }),\n            });\n            const data = await response.json();\n            return res.json({ ok: response.ok, data });\n        } catch (err) {\n            return res.status(500).json({ error: err?.message || String(err) });\n        }\n    });\n\n    // Serve UI files"
  );
}

if (content !== before) {
  fs.writeFileSync(target, content, 'utf8');
  console.log('✅ Patched webServer.js');
} else {
  console.log('ℹ️ webServer.js already patched');
}
