const socket = io();

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
  '0x2105': {
    name: 'Base',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  },
  '0x1': {
    name: 'Ethereum',
    usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
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

socket.on('response_complete', (data) => {
  if (data?.text) addMessage(data.text, 'assistant');
});

socket.on('error', (err) => {
  addMessage(`Error: ${err?.message || err?.error || 'Unknown error'}`, 'assistant');
});

sendBtn.addEventListener('click', () => {
  const msg = inputEl.value.trim();
  if (!msg) return;
  addMessage(msg, 'user');
  inputEl.value = '';
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
    const erc20Abi = ['function balanceOf(address owner) view returns (uint256)', 'function decimals() view returns (uint8)'];
    const contract = new ethers.Contract(chain.usdc, erc20Abi, provider);
    const bal = await contract.balanceOf(currentAddress);
    const decimals = await contract.decimals();
    const formatted = ethers.formatUnits(bal, decimals);
    usdcEl.textContent = `${Number(formatted).toFixed(4)} USDC`;
  } catch (err) {
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
