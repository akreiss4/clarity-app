const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const plaidConfig = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

const TOKENS_FILE = path.join(__dirname, 'tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch { }
  return [];
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens));
}

let accessTokens = loadTokens();

app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'clarity-user' },
      client_name: 'Clarity',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    });
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create link token' });
  }
});

app.post('/api/exchange-token', async (req, res) => {
  try {
    const { public_token } = req.body;
    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    accessTokens.push(response.data.access_token);
    saveTokens(accessTokens);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const allTransactions = [];
    const allAccounts = [];
    for (const token of accessTokens) {
      const now = new Date();
      const start = new Date();
      start.setDate(now.getDate() - 30);
      const response = await plaidClient.transactionsGet({
        access_token: token,
        start_date: start.toISOString().split('T')[0],
        end_date: now.toISOString().split('T')[0],
      });
      allTransactions.push(...response.data.transactions);
      allAccounts.push(...response.data.accounts);
    }
    res.json({ transactions: allTransactions, accounts: allAccounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const allAccounts = [];
    for (const token of accessTokens) {
      const response = await plaidClient.accountsBalanceGet({ access_token: token });
      allAccounts.push(...response.data.accounts);
    }
    res.json({ accounts: allAccounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

app.get('/api/reset-tokens', (req, res) => {
  accessTokens = [];
  saveTokens([]);
  res.json({ success: true, message: 'Tokens cleared' });
});
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Clarity server running on port ${PORT}`));