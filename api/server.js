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

async function fetchAllTransactions(token) {
  const now = new Date();
  const start = new Date();
  start.setDate(now.getDate() - 365);
  const start_date = start.toISOString().split('T')[0];
  const end_date = now.toISOString().split('T')[0];

  let offset = 0;
  const count = 500;
  let total = null;
  const transactions = [];
  let accounts = [];

  while (total === null || offset < total) {
    const response = await plaidClient.transactionsGet({
      access_token: token,
      start_date,
      end_date,
      options: { count, offset },
    });
    transactions.push(...response.data.transactions);
    accounts = response.data.accounts;
    total = response.data.total_transactions;
    offset += response.data.transactions.length;
    if (!response.data.transactions.length) break;
  }

  return { transactions, accounts };
}

app.post('/api/create-link-token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'clarity-user' },
      client_name: 'Clarity',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      transactions: { days_requested: 730 },
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
    plaidClient.transactionsRefresh({ access_token: response.data.access_token }).catch(err => {
      console.error('transactionsRefresh:', err.response?.data || err.message);
    });
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
    const seenAccounts = new Set();
    const allAccounts = [];
    for (const token of tokens) {
      const { transactions, accounts } = await fetchAllTransactions(token);
      allTransactions.push(...transactions);
      for (const account of accounts) {
        if (!seenAccounts.has(account.account_id)) {
          seenAccounts.add(account.account_id);
          allAccounts.push(account);
        }
      }
    }
    res.json({ transactions: allTransactions, accounts: allAccounts });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

app.post('/api/refresh-transactions', async (req, res) => {
  try {
    const tokens = await getTokens();
    for (const token of tokens) {
      await plaidClient.transactionsRefresh({ access_token: token });
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to refresh transactions' });
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

app.get('/api/spending-history', async (req, res) => {
  try {
    const history = await redis.get('clarity:spending_history') || [];
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get spending history' });
  }
});

app.post('/api/spending-history', async (req, res) => {
  try {
    const { month, year, income, expenses, categories } = req.body;
    const history = await redis.get('clarity:spending_history') || [];
    const key = `${year}-${month}`;
    const filtered = history.filter(h => h.key !== key);
    filtered.push({ key, month, year, income, expenses, categories });
    const trimmed = filtered.slice(-12);
    await redis.set('clarity:spending_history', trimmed);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save spending history' });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Clarity server running on port ${PORT}`));