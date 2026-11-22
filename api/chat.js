// MORA STORE AI assistant endpoint (Vercel serverless function).
// POST /api/chat  {message, history:[{role,text}], context:{catalog,faq,offers,payment}}
// -> {reply} | 503 {error:'not_configured'} | 429 {error:'rate_limited'} | 502 {error:'upstream'}
//
// The LLM API key lives ONLY in Vercel environment variables:
//   GROQ_API_KEY   (preferred, free tier at console.groq.com)
//   GEMINI_API_KEY (alternative, free tier at aistudio.google.com)
// Nothing secret ever ships in the client.

const RATE_WINDOW_MS = 60000;
const RATE_MAX = 20; // requests per IP per minute (per warm instance)
const hits = new Map();

function rateOk(ip) {
  const now = Date.now();
  let rec = hits.get(ip);
  if (!rec || now > rec.reset) { rec = { count: 0, reset: now + RATE_WINDOW_MS }; hits.set(ip, rec); }
  rec.count += 1;
  if (hits.size > 5000) hits.clear();
  return rec.count <= RATE_MAX;
}

const RULES = [
  'أنت مساعد متجر MORA STORE داخل الموقع. اتكلم بالعامية المصرية البسيطة والمحترمة، نفس أسلوب الموقع.',
  'قواعد صارمة لا يمكن كسرها أبدًا:',
  '1) جاوب فقط من بيانات الكتالوج والأسئلة الشائعة والعروض وطرق الدفع المرفقة تحت عنوان "بيانات المتجر الحالية". ممنوع تخترع خدمة أو سعر أو مدة أو سياسة مش موجودة في البيانات.',
  '2) ممنوع منعًا باتًا تأكيد أي دفع أو استلام إيصال أو تنفيذ طلب أو معرفة حالة طلب فعلية. لو المستخدم سأل عن تأكيد دفع أو إيصال أو تنفيذ أو حالة طلب، وضّح إنك مش بتقدر تتأكد منها من الشات، ووجّهه لصفحة السلة/الدفع في الموقع أو لدعم واتساب من زر «تواصل مع الدعم».',
  '3) أي سؤال خارج خدمات المتجر أو مش متغطي في البيانات: اعتذر باختصار وقول إنك مساعد متخصص في خدمات MORA STORE، ووجّه للدعم لو محتاج.',
  '4) ممنوع تطلب كلمة مرور أو كود تحقق أو بيانات بطاقة كاملة أو أي بيانات سرية.',
  '5) في الحسابات استخدم أرقام الكتالوج المرفقة كما هي، ولو حسبت تكلفة اذكر إن السعر النهائي يتراجع في السلة قبل الدفع.',
  '6) لو الخدمة مكتوب عليها «بدون ضمان» في البيانات، اذكر ده بوضوح عند السؤال عن الضمان أو التعويض.',
  '7) خلي ردك قصير وواضح (أقل من 120 كلمة غالبًا)، ورتبه بنقاط لو فيه خطوات أو أسعار متعددة.'
].join('\n');

function cap(s, n) { return typeof s === 'string' ? s.slice(0, n) : ''; }

async function askGroq(key, system, history, message) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'system', content: system }]
        .concat(history.map(h => ({ role: h.role === 'bot' ? 'assistant' : 'user', content: cap(h.text, 1000) })))
        .concat([{ role: 'user', content: message }]),
      max_tokens: 600,
      temperature: 0.3
    })
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  const data = await r.json();
  const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!reply) throw new Error('groq empty');
  return reply.trim();
}

async function askGemini(key, system, history, message) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(key);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: history.map(h => ({ role: h.role === 'bot' ? 'model' : 'user', parts: [{ text: cap(h.text, 1000) }] }))
        .concat([{ role: 'user', parts: [{ text: message }] }]),
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    })
  });
  if (!r.ok) throw new Error('gemini ' + r.status);
  const data = await r.json();
  const parts = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const reply = parts && parts.map(p => p.text || '').join('').trim();
  if (!reply) throw new Error('gemini empty');
  return reply;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.status(405).end(JSON.stringify({ error: 'method_not_allowed' }));
    return;
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (!rateOk(ip)) {
    res.status(429).end(JSON.stringify({ error: 'rate_limited' }));
    return;
  }
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  if (!groqKey && !geminiKey) {
    res.status(503).end(JSON.stringify({ error: 'not_configured' }));
    return;
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body.message !== 'string' || !body.message.trim()) {
    res.status(400).end(JSON.stringify({ error: 'bad_request' }));
    return;
  }
  const message = body.message.slice(0, 1000);
  const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
  const ctx = body.context || {};
  const storeData = [
    'بيانات المتجر الحالية:',
    '== كتالوج الخدمات والأسعار ==', cap(ctx.catalog, 14000),
    '== العروض والباقات ==', cap(ctx.offers, 6000),
    '== طرق الدفع ==', cap(ctx.payment, 2000),
    '== الأسئلة الشائعة ==', cap(ctx.faq, 6000)
  ].join('\n');
  const system = RULES + '\n\n' + storeData;
  try {
    const reply = groqKey ? await askGroq(groqKey, system, history, message)
                          : await askGemini(geminiKey, system, history, message);
    res.status(200).end(JSON.stringify({ reply }));
  } catch (e) {
    res.status(502).end(JSON.stringify({ error: 'upstream' }));
  }
};
