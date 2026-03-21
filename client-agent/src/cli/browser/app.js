const socket = io();

const DEFAULT_MERCHANT = '0x9f869e3029accb093ae7ab0cd244ccc6d9eab554';

const connectBtn = document.getElementById('connectBtn');
const statusEl = document.getElementById('status');
const addressEl = document.getElementById('address');
const accountSelect = document.getElementById('accountSelect');
const chainSelect = document.getElementById('chainSelect');
const usdcEl = document.getElementById('usdc');
const ethEl = document.getElementById('eth');
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

let provider = null;
let signer = null;
let currentAddress = null;
let accounts = [];

const CHAINS = {
  '0x14a34': {
    name: 'Base Sepolia',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  },
};

function addMessage(text, role = 'assistant') {
  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerText = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

socket.on('connect', () => {
  socket.emit('initialize_agent', {});
});

socket.on('agent_initialized', () => {
  addMessage('Agent initialized. Ask me something!', 'assistant');
});

socket.on('response', (data) => {
  if (data?.text) addMessage(data.text, 'assistant');
});

let lastPayment = null;

socket.on('response_complete', (data) => {
  if (data?.text) {
    addMessage(data.text, 'assistant');
    // parse payment details
    if (data.text.toLowerCase().includes('payment') || data.text.toLowerCase().includes('requesting')) {
      const productMatch = data.text.match(/Product:\s*(.+)/i) || data.text.match(/for the (.+?)\./i);
      const priceMatch = data.text.match(/Price:\s*([0-9.]+)\s*USDC\s*\((\d+) atomic units\)/i)
        || data.text.match(/requesting\s*([0-9.]+)\s*USDC/i);
      const merchantMatch = data.text.match(/Merchant(?: Address)?:\s*(0x[a-fA-F0-9]{40})/i)
        || data.text.match(/Merchant:\s*(0x[a-fA-F0-9]{40})/i)
        || data.text.match(/payTo:\s*(0x[a-fA-F0-9]{40})/i);
      const amountAtomic = priceMatch?.[2] || (priceMatch?.[1] ? String(Math.round(Number(priceMatch[1]) * 1_000_000)) : null);
      lastPayment = {
        product: productMatch?.[1]?.trim(),
        amountAtomic,
        merchant: DEFAULT_MERCHANT,
      };
      console.log('Parsed payment details', lastPayment);
    }
  }
});

socket.on('error', (err) => {
  addMessage(`Error: ${err?.message || err?.error || 'Unknown error'}`, 'assistant');
});

sendBtn.addEventListener('click', async () => {
  const msg = inputEl.value.trim();
  if (!msg) return;
  addMessage(msg, 'user');
  inputEl.value = '';

  const lower = msg.toLowerCase();
  if (lastPayment && (lower === 'proceed' || lower === 'yes')) {
    try {
      if (!lastPayment.merchant || !lastPayment.amountAtomic) {
        addMessage(`Payment failed: Missing payment details. Parsed: ${JSON.stringify(lastPayment)}`, 'assistant');
        return;
      }
      await executeMetaMaskPayment(lastPayment);
      return;
    } catch (err) {
      addMessage(`Payment failed: ${err?.message || err}`, 'assistant');
      return;
    }
  }

  socket.emit('message', { message: msg });
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

function renderAccounts() {
  accountSelect.innerHTML = '';
  accounts.forEach((acct) => {
    const opt = document.createElement('option');
    opt.value = acct;
    opt.textContent = acct;
    accountSelect.appendChild(opt);
  });
  if (currentAddress) {
    accountSelect.value = currentAddress;
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    statusEl.textContent = 'MetaMask not found';
    return;
  }

  provider = new ethers.BrowserProvider(window.ethereum);
  accounts = await provider.send('eth_requestAccounts', []);
  signer = await provider.getSigner();
  currentAddress = await signer.getAddress();

  try {
    await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: '0x14a34',
      chainName: 'Base Sepolia',
      rpcUrls: ['https://sepolia.base.org'],
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://sepolia.basescan.org']
    }]});
  } catch (err) {
    // ignore add chain errors
  }

  try {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
  } catch (err) {
    // ignore; user may need to switch manually
  }

  // refresh provider/signer after chain switch
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  const chainId = await provider.send('eth_chainId', []);
  if (chainId && CHAINS[chainId]) {
    chainSelect.value = chainId;
  }

  statusEl.textContent = `Connected (${CHAINS[chainSelect.value]?.name || chainSelect.value})`;
  addressEl.textContent = currentAddress;
  renderAccounts();

  await refreshUsdcBalance();
  await refreshEthBalance();
}

async function refreshUsdcBalance() {
  if (!provider || !currentAddress) return;
  const chainId = chainSelect.value;
  const chain = CHAINS[chainId];
  if (!chain) {
    usdcEl.textContent = '—';
    return;
  }

  try {
    // skip contract code check; rely on balance call
    const erc20Abi = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)'];
    const contract = new ethers.Contract(chain.usdc, erc20Abi, provider);
    const bal = await contract.balanceOf(currentAddress);
    const decimals = await contract.decimals();
    const formatted = ethers.formatUnits(bal, decimals);
    usdcEl.textContent = `${Number(formatted).toFixed(4)} USDC`;
  } catch (err) {
    console.warn('USDC fetch failed', err);
    usdcEl.textContent = 'Unavailable';
  }
}

async function refreshEthBalance() {
  if (!provider || !currentAddress) return;
  try {
    const bal = await provider.getBalance(currentAddress);
    ethEl.textContent = `${Number(ethers.formatEther(bal)).toFixed(4)} ETH`;
  } catch (err) {
    ethEl.textContent = 'Unavailable';
  }
}

async function executeMetaMaskPayment(details) {
  if (!provider || !signer || !currentAddress) {
    throw new Error('Wallet not connected');
  }
  if (!details?.merchant || !details?.amountAtomic) {
    throw new Error('Missing payment details');
  }
  let chainId = await provider.send('eth_chainId', []);
  if (chainId !== '0x14a34') {
    await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
    // wait a tick for MetaMask to update
    await new Promise(r => setTimeout(r, 500));
  }
  // re-init after switch
  provider = new ethers.BrowserProvider(window.ethereum);
  signer = await provider.getSigner();
  chainId = await provider.send('eth_chainId', []);
  if (chainId !== '0x14a34') {
    throw new Error(`Wrong chain: ${chainId}. Please switch to Base Sepolia (84532).`);
  }
  const chain = CHAINS['0x14a34'];

  // USDC transfer
  const erc20Abi = ['function transfer(address to, uint256 value) returns (bool)'];
  const contract = new ethers.Contract(chain.usdc, erc20Abi, signer);
  const tx = await contract.transfer(details.merchant, details.amountAtomic);
  addMessage(`Submitting payment tx: ${tx.hash}`, 'assistant');
  const receipt = await tx.wait();

  // Relay to backend
  const payload = {
    merchantUrl: 'http://localhost:10000',
    productName: details.product || 'product',
    txHash: receipt?.hash || tx.hash,
    payer: currentAddress,
    amount: details.amountAtomic,
    tokenAddress: chain.usdc,
    network: chain.name,
  };

  const res = await fetch('/api/payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || 'Payment relay failed');

  // Try to surface merchant response
  const events = data?.data?.events || data?.data?.data?.events || [];
  let merchantText = '';
  for (const event of events) {
    const msg = event?.status?.message;
    const parts = msg?.parts || [];
    const text = parts.map((p) => p.text).filter(Boolean).join('\n');
    if (text) merchantText = text;
  }
  if (merchantText) {
    addMessage(`✅ Payment relayed.\n${merchantText}`, 'assistant');
  } else {
    addMessage('✅ Payment relayed to merchant.', 'assistant');
  }

  lastPayment = null;
}

connectBtn.addEventListener('click', connectWallet);

accountSelect.addEventListener('change', async () => {
  currentAddress = accountSelect.value;
  addressEl.textContent = currentAddress;
  await refreshUsdcBalance();
  await refreshEthBalance();
});

if (window.ethereum) {
  window.ethereum.on('accountsChanged', (newAccounts) => {
    accounts = newAccounts || [];
    currentAddress = accounts[0] || null;
    addressEl.textContent = currentAddress || '—';
    renderAccounts();
    statusEl.textContent = `Connected (${CHAINS[chainSelect.value]?.name || chainSelect.value})`;
    refreshUsdcBalance();
    refreshEthBalance();
  });

  window.ethereum.on('chainChanged', (chainId) => {
    if (chainId && CHAINS[chainId]) {
      chainSelect.value = chainId;
      statusEl.textContent = `Connected (${CHAINS[chainId].name})`;
    }
    refreshUsdcBalance();
    refreshEthBalance();
  });
}

chainSelect.addEventListener('change', async () => {
  if (!window.ethereum) return;
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: chainSelect.value }],
    });
  } catch (err) {
    console.warn('Chain switch failed', err);
  }
  statusEl.textContent = `Connected (${CHAINS[chainSelect.value]?.name || chainSelect.value})`;
  await refreshUsdcBalance();
  await refreshEthBalance();
});
