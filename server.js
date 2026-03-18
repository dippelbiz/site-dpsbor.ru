require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ==================== API (оставляем как есть) ====================
app.get('/api/products', async (req, res) => {
  try {
    const products = await pool.query(`
      SELECT id, name, description, image, category 
      FROM products 
      ORDER BY id
    `);
    
    const variants = await pool.query(`
      SELECT 
        v.id, v.product_id, v.name, v.price, 
        v.weight_kg, v.packaging_cost, v.is_active
      FROM product_variants v
      ORDER BY v.product_id, v.sort_order
    `);
    
    const variantsByProduct = {};
    variants.rows.forEach(v => {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push({
        id: v.id,
        name: v.name,
        price: v.price,
        weight_kg: v.weight_kg,
        packaging_cost: v.packaging_cost,
        is_active: v.is_active
      });
    });

    const result = products.rows.map(p => ({
      id: p.id,
      name: p.name,
      description: p.description,
      image: p.image,
      category: p.category,
      variants: variantsByProduct[p.id] || []
    }));
    
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==================== САЙТ (новая версия) ====================
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/website/index.html');
});

// ==================== СТАРЫЕ СТРАНИЦЫ (оставляем для совместимости) ====================
app.get('/index.html', (req, res) => {
  res.redirect('/');
});

app.get('/cart.html', (req, res) => {
  res.sendFile(__dirname + '/public/cart.html');
});

app.get('/orders.html', (req, res) => {
  res.sendFile(__dirname + '/public/orders.html');
});

app.get('/checkout.html', (req, res) => {
  res.sendFile(__dirname + '/public/checkout.html');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
