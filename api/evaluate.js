const LNBITS_URL    = process.env.LNBITS_URL;
const LNBITS_KEY    = process.env.LNBITS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_SATS     = 10;
const MAX_SATS      = 50;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const { comment, star } = req.body;
  if (!comment || comment.length < 5) return res.status(400).json({ error: 'コメントが短すぎます' });
  try {
    const scores = await evaluateWithClaude(comment, star);
    const avg    = (scores.specificity + scores.actionability + scores.sentiment_balance) / 3;
    const sats   = Math.round(BASE_SATS + (avg / 10) * (MAX_SATS - BASE_SATS));
    const withdrawLink = await createWithdrawLink(sats, comment);
    res.status(200).json({ scores, comment: scores.comment, sats, lnurl: withdrawLink.lnurl });
  } catch (err) {
    console.error('ERROR:', err.message);
    res.status(500).json({ error: err.message });
  }
}

async function evaluateWithClaude(comment, star) {
  const prompt = `イベントフィードバックを3軸で評価し、JSONのみ返してください。余計な文字は不要です。\n\nフィードバック:「${comment}」\n星評価: ${star || '未選択'}/5\n\n返却形式:\n{"specificity":7,"actionability":5,"sentiment_balance":6,"comment":"コメント1文目。コメント2文目。"}`;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] }),
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
  console.log('Creating withdraw link for', sats, 'sats');
  const response = await fetch(`${LNBITS_URL}/withdraw/api/v1/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': LNBITS_KEY },
    body: JSON.stringify({
      title: 'フィードバック報酬',
      min_withdrawable: sats,
      max_withdrawable: sats,
      uses: 1,
      wait_time: 1,
      is_unique: true,
    }),
  });
  console.log('LNURLw status:', response.status);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LNURLwエラー: ${err}`);
  }
  const data = await response.json();
  console.log('LNURLw response:', JSON.stringify(data));
  return { lnurl: data.lnurl };
}
