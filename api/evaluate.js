// api/evaluate.js
const LNBITS_URL    = process.env.LNBITS_URL;
const LNBITS_KEY    = process.env.LNBITS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_URL    = 'https://script.google.com/macros/s/AKfycbxWlpkpaB48uQdzd_m7-PXaoCJeFIT5CbO048WOHAADYcZRuzDPGxD6GTMZQlZSNr_3/exec';
const BASE_SATS     = 1;
const MAX_SATS      = 10;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { comment, star, lang, q1Answer, q2Answer } = req.body;
  if (!comment || comment.length < 5) return res.status(400).json({ error: 'コメントが短すぎます' });

  try {
    // 1. AIでスコア評価
    const scores = await evaluateWithClaude(comment, star);
    const avg    = (scores.specificity + scores.actionability + scores.sentiment_balance) / 3;
    const sats   = avg < 1 ? 1 : Math.round(BASE_SATS + (avg / 10) * (MAX_SATS - BASE_SATS));

    // 2. LNURLw Withdraw Link発行
    const withdrawLink = await createWithdrawLink(sats, comment);

    // 3. Googleスプレッドシートに保存（失敗してもメイン処理は継続）
    saveToSheets({ lang, scores, sats, comment, q1Answer, q2Answer }).catch(err => {
      console.error('Sheets保存エラー:', err.message);
    });

    res.status(200).json({
      scores,
      comment: scores.comment,
      sats,
      lnurl: withdrawLink.lnurl,
    });
  } catch (err) {
    console.error('ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
}

async function evaluateWithClaude(comment, star) {
  const HIGH_SCORE_EXAMPLE = 'Lightning報酬の即時性は素晴らしいです。ただ、AIの採点基準が不透明で、なぜこのスコアになったのか理解しにくいです。具体的には「Specificity」の定義と、高スコアを取るための例を3つほどフォーム上に表示してほしいです。';

  const prompt = `SatsReviewというサービスへのフィードバックを3軸で評価し、JSONのみ返してください。余計な文字は不要です。

フィードバック:「${comment}」
星評価: ${star || '未選択'}/5

【重要な評価ルール】
・意味不明・スパム・無意味な文字列・単なる記号・同じ文字の繰り返しの場合は全スコアを0にしてください。
・このサービスのテーマ（Lightning決済・AIによる評価・フィードバックの質・マイクロリワード・インセンティブ設計・Bitcoinなど）に全く関係のない内容（ニュース・時事ネタ・料理・スポーツ・運転マニュアルなど）の場合は全スコアを2以下にしてください。
・以下の例文と同じ、または非常に似ている場合は各スコアを2〜3点にしてください（コピーペーストや軽微な改変を検出してください）：
「${HIGH_SCORE_EXAMPLE}」
・自分の言葉で書かれたオリジナルのフィードバックを高く評価してください。

返却形式:
{"specificity":7,"actionability":5,"sentiment_balance":6,"comment":"コメント1文目。コメント2文目。"}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const data = await response.json();
  console.log('Anthropic status:', response.status);

  if (!response.ok) throw new Error(`Anthropic APIエラー: ${data.error?.message || response.status}`);
  if (!data.content || !Array.isArray(data.content)) throw new Error(`予期しないレスポンス: ${JSON.stringify(data)}`);

  const raw    = data.content.map(i => i.text || '').join('').replace(/```json|```/g, '').trim();
  const result = JSON.parse(raw);

  return {
    specificity:       Math.min(10, Math.max(0, Math.round(result.specificity))),
    actionability:     Math.min(10, Math.max(0, Math.round(result.actionability))),
    sentiment_balance: Math.min(10, Math.max(0, Math.round(result.sentiment_balance))),
    comment:           result.comment,
  };
}

async function createWithdrawLink(sats, memo) {
  const response = await fetch(`${LNBITS_URL}/withdraw/api/v1/links`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': LNBITS_KEY,
    },
    body: JSON.stringify({
      title:            memo.slice(0, 250),
      min_withdrawable: sats,
      max_withdrawable: sats,
      uses:             1,
      wait_time:        1,
      is_unique:        true,
      memo:             memo.slice(0, 250),
    }),
  });

  console.log('LNURLw status:', response.status);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LNURLwエラー: ${err}`);
  }

  const data = await response.json();
  return { lnurl: data.lnurl };
}

// Googleスプレッドシートに保存
async function saveToSheets({ lang, scores, sats, comment, q1Answer, q2Answer }) {
  const params = new URLSearchParams({
    lang:              lang || 'ja',
    specificity:       String(scores.specificity),
    actionability:     String(scores.actionability),
    sentiment_balance: String(scores.sentiment_balance),
    sats:              String(sats),
    comment:           comment,
    q1Answer:          q1Answer || '未回答',
    q2Answer:          q2Answer || '未回答',
    action:            'write',
  });
  const url = SHEETS_URL + '?' + params.toString();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
  });
  console.log('Sheets status:', response.status);
  const text = await response.text();
  console.log('Sheets response:', text);
}
