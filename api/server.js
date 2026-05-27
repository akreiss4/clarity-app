const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const { Redis } = require('@upstash/redis');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

async function getTokens() {
  try {
    const tokens = await redis.get('clarity:access_tokens');
    return tokens || [];
  } catch { return []; }
}

async function saveTokens(tokens) {
  await redis.set('clarity:access_tokens', tokens);
}

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
    const tokens = await getTokens();
    tokens.push(response.data.access_token);
    await saveTokens(tokens);
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to exchange token' });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const tokens = await getTokens();
    const allTransactions = [];
    const allAccounts = [];
    for (const token of tokens) {
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
    const tokens = await getTokens();
    const allAccounts = [];
    for (const token of tokens) {
      const response = await plaidClient.accountsBalanceGet({ access_token: token });
      allAccounts.push(...response.data.accounts);
    }
    res.json({ accounts: allAccounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

app.get('/api/reset-tokens', async (req, res) => {
  await saveTokens([]);
  res.json({ success: true, message: 'Tokens cleared' });
});

app.post('/api/networth', async (req, res) => {
  try {
    const { netWorth, assets, liabilities } = req.body;
    const history = await redis.get('clarity:networth_history') || [];
    const entry = {
      date: new Date().toISOString().split('T')[0],
      netWorth,
      assets,
      liabilities
    };
    // Only add one entry per day
    const today = entry.date;
    const filtered = history.filter(h => h.date !== today);
    filtered.push(entry);
    // Keep last 12 months
    const trimmed = filtered.slice(-365);
    await redis.set('clarity:networth_history', trimmed);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save net worth' });
  }
});

app.get('/api/networth', async (req, res) => {
  try {
    const history = await redis.get('clarity:networth_history') || [];
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get net worth history' });
  }
});

app.get('/api/budgets', async (req, res) => {
  try {
    const budgets = await redis.get('clarity:budgets') || {};
    res.json({ budgets });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get budgets' });
  }
});

app.post('/api/budgets', async (req, res) => {
  try {
    const { budgets } = req.body;
    await redis.set('clarity:budgets', budgets);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save budgets' });
  }
});

app.get('/api/bills', async (req, res) => {
  try {
    const bills = await redis.get('clarity:bills') || [];
    res.json({ bills });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get bills' });
  }
});

app.post('/api/bills', async (req, res) => {
  try {
    const { bills } = req.body;
    await redis.set('clarity:bills', bills);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save bills' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Clarity server running on port ${PORT}`));