// api/evaluate.js
// Vercel Serverless Function
// フィードバック評価 + LNbits Invoice発行

const LNBITS_URL    = process.env.LNBITS_URL;      // 例: https://legend.lnbits.com
const LNBITS_KEY    = process.env.LNBITS_API_KEY;  // Invoice/read key
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_SATS     = 10;
const MAX_SATS      = 50;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { comment, star, email } = req.body;
  if (!comment || comment.length < 5) return res.status(400).json({ error: 'コメントが短すぎます' });

  try {
    // 1. AIでスコア評価
    const scores = await evaluateWithClaude(comment, star);
    const avg    = Object.values(scores).reduce((a, b) => a + b, 0) / 3;
    const sats   = Math.round(BASE_SATS + (avg / 10) * (MAX_SATS - BASE_SATS));

    // 2. LNbitsでInvoice発行
    const invoice = await createLNbitsInvoice(sats, comment);

    res.status(200).json({
      scores,
      comment: scores.comment,
      sats,
      invoice: invoice.payment_request,
      paymentHash: invoice.payment_hash,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}

// -------------------------------------------------------
// Claude APIでフィードバック評価
// -------------------------------------------------------
async function evaluateWithClaude(comment, star) {
  const prompt = `イベントフィードバックを3軸で評価し、JSONのみ返してください。

フィードバック:「${comment}」
星評価: ${star || '未選択'}/5

{"specificity":0から10の整数,"actionability":0から10の整数,"sentiment_balance":0から10の整数,"comment":"日本語で2文のコメント"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  const raw  = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim();
  const result = JSON.parse(raw);

  return {
    specificity:        Math.min(10, Math.max(0, Math.round(result.specificity))),
    actionability:      Math.min(10, Math.max(0, Math.round(result.actionability))),
    sentiment_balance:  Math.min(10, Math.max(0, Math.round(result.sentiment_balance))),
    comment:            result.comment,
  };
}

// -------------------------------------------------------
// LNbitsでLightning Invoice発行
// -------------------------------------------------------
async function createLNbitsInvoice(sats, memo) {
  const response = await fetch(`${LNBITS_URL}/api/v1/payments`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': LNBITS_KEY,
    },
    body: JSON.stringify({
      out:    false,
      amount: sats,
      memo:   `フィードバック報酬: ${memo.slice(0, 40)}`,
      expiry: 3600,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LNbits エラー: ${err}`);
  }

  return response.json();
}
