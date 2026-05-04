// api/evaluate.js
const LNBITS_URL    = process.env.LNBITS_URL;
const LNBITS_KEY    = process.env.LNBITS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SHEETS_URL    = 'https://script.google.com/macros/s/AKfycbxWlpkpaB48uQdzd_m7-PXaoCJeFIT5CbO048WOHAADYcZRuzDPGxD6GTMZQlZSNr_3/exec';
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const BASE_SATS     = 1;
const MAX_SATS      = 10;
const RATE_LIMIT_SECONDS = 3600; // 1時間に1回

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { comment, star, lang, q1Answer, q2Answer } = req.body;
  if (!comment || comment.length < 5) return res.status(400).json({ error: 'コメントが短すぎます' });

  // IPレート制限チェック
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown';
  const rateLimitKey = `satsreview:${ip}`;
  const isLimited = await checkRateLimit(rateLimitKey);
  if (isLimited) {
    return res.status(429).json({ error: 'しばらく時間をおいてから再度お試しください（1時間に1回まで）' });
  }

  try {
    // 1. AIでスコア評価
    const scores = await evaluateWithClaude(comment, star);
    const avg    = (scores.specificity + scores.actionability + scores.sentiment_balance) / 3;
    const sats   = avg < 1 ? 1 : Math.round(BASE_SATS + (avg / 10) * (MAX_SATS - BASE_SATS));

    // 2. LNURLw Withdraw Link発行
    const withdrawLink = await createWithdrawLink(sats, comment);

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

// Upstash RedisでIPレート制限
async function checkRateLimit(key) {
  try {
    const res = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    const data = await res.json();
    if (data.result) return true; // 制限中

    // キーをセット（TTL付き）
    await fetch(`${REDIS_URL}/set/${key}/1/ex/${RATE_LIMIT_SECONDS}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    return false;
  } catch(e) {
    console.error('Redis error:', e.message);
    return false; // Redisエラー時は通す
  }
}

async function evaluateWithClaude(comment, star) {
  const HIGH_SCORE_EXAMPLE = 'Lightning報酬の即時性は素晴らしいです。ただ、AIの採点基準が不透明で、なぜこのスコアになったのか理解しにくいです。具体的には「Specificity」の定義と、高スコアを取るための例を3つほどフォーム上に表示してほしいです。';
  const BLACKLIST = [
    'Lightningの即時報酬は優れた体験ですが、AIの採点基準が不透明で、評価理由が分かりにくいです。「Specificity」の定義と、高スコアの具体例を3つほど表示してほしいです。',
    'Lightningの即時フィードバックは非常に良いですが、AIの評価基準が不透明で、スコアの理由が見えません。「Specificity」の定義を明確にし、高スコアのサンプルを3つほど表示していただきたいです。',
    '¿Menciona lo bueno y lo malo? Se aprecia más cuando la crítica es constructiva y tiene contexto.',
  ];
  const isBlacklisted = BLACKLIST.some(b => comment.includes(b.slice(0, 30)));

  const prompt = `SatsReviewというサービスへのフィードバックを3軸で評価し、JSONのみ返してください。余計な文字は不要です。

フィードバック:「${comment}」
星評価: ${star || '未選択'}/5

【重要な評価ルール】
・意味不明・スパム・無意味な文字列・単なる記号・同じ文字の繰り返しの場合は全スコアを0にしてください。
・同じ文章や文節が2回以上繰り返されている場合は全スコアを0にしてください。
・このサービス（Lightning×AI評価×マイクロリワードのフィードバックシステム）に対する意見・感想・提案・批評ではない内容の場合は全スコアを2以下にしてください。具体的には、ニュース記事・時事ネタ・為替・経済情報・料理・スポーツ・運転マニュアル・論文・小説・その他このサービスと無関係なテキストは全て低スコアにしてください。「このサービスについて自分の言葉で書かれた意見や体験」のみ高スコアの対象です。
・以下のブラックリスト文章と同じ、または非常に似ている場合は全スコアを0にしてください（botによる大量送信が確認されています）：
「Lightningの即時報酬は優れた体験ですが、AIの採点基準が不透明で、評価理由が分かりにくいです」
「Lightningの即時フィードバックは非常に良いですが、AIの評価基準が不透明で」
「¿Menciona lo bueno y lo malo? Se aprecia más cuando la crítica es constructiva」
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


