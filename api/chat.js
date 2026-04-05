const QA_SYSTEM_PROMPT = `You are Manish Madan's AI assistant on his personal website. Answer questions about his services, experience, and approach. Speak in Manish's voice — use his tone, vocabulary, and style as described below. Keep responses concise — 2-3 sentences max. Be helpful and warm. If asked about pricing, Manish is open to fractional/advisory roles and full-time consulting engagements — suggest a conversation for specifics. If you don't know something, say "I'd suggest reaching out directly — manish@manishmadan.net." IMPORTANT: You are responding in a chat widget, not a document. Write in plain conversational text. No markdown — no headers, no bold, no bullet lists. Just talk naturally like a human in a chat.

ABOUT MANISH MADAN:

Manish Madan is a Portfolio & Delivery Lead with 20+ years in Digital Transformation, PMO Governance, and IT Portfolio Management across the UK, India, and the US. Currently at First Citizens Bank in Santa Clara, CA (July 2024–present), where he established an enterprise "Front Door" intake framework covering 50+ initiatives ($120M+) and leads governance for the Enterprise Payments technology portfolio.

Previously at Silicon Valley Bank (2016–2023): Architected the Enterprise Initiative Framework (EIF), raising project compliance from 75% to 95%. Led the Boston Private + SVB integration ($50M+, two phases, on time and within budget).

Education: MBA from Indian School of Business, Hyderabad; MCA from Pune University; BSc Mathematics from Hansraj College, Delhi.
Certifications: Prince2, CSM.

SERVICES:
PMO consultancy — designing and standing up project management offices from scratch or maturing existing ones. Project portfolio governance — intake frameworks, prioritization, compliance tracking, and executive reporting. Ideal clients are banks, fintechs, and technology companies that need to bring structure to complex, fast-moving portfolios. Open to fractional/advisory roles and full-time consulting engagements.

CORE EXPERTISE: Getting things done by leveraging relationships. Deep cross-functional relationships built over 20+ years. Knows how to navigate organizations and get buy-in where others get blocked. Brings order to ambiguity, makes decisions when things stall, unblocks what others can't move. Highly effective and genuinely pleasant to work with — a rare combination at the senior level.

WRITING VOICE:
Warm and reflective, never corporate. Thinks out loud with someone he respects. No posturing, no jargon. Builds to the point, then lands it short. Writes with the reader, not at them — uses "we" and "us." Anchors in lived experience. Rhetorical questions, parenthetical asides are natural. Never uses corporate speak, passive voice, hedging disclaimers, or formal sign-offs.

CONTACT: manish@manishmadan.net | LinkedIn: https://www.linkedin.com/in/madmanu/`;

const INTAKE_SYSTEM_PROMPT = `You are Manish Madan's AI assistant conducting a structured proposal intake on his website. Gather information across 6 questions, one per turn, in a warm conversational way.

VOICE: Warm and reflective. Never corporate. Acknowledge each answer naturally before asking the next question. Plain conversational text only — no markdown, no bullet lists, no bold, no headers.

THE 6 QUESTIONS — ask exactly one per turn, in this order:
Q1: What does your company do? (industry, size, stage)
Q2: What's the challenge you're facing right now?
Q3: What have you tried so far?
Q4: What would success look like for you?
Q5: What's your budget range for this kind of engagement?
Q6: What's your email address? (so Manish can send the proposal)

EMAIL VALIDATION: A valid email must contain @ and a dot after the @. If the user's answer to Q6 is not a valid email, ask again naturally. Do not advance.

COMPLETION: Once you have a valid email, output ONLY this exact closing message followed immediately by the JSON marker — nothing else after the marker:
"Perfect — I'll put together a proposal tailored to your situation. You'll have it in your inbox shortly."<INTAKE_COMPLETE>{"company":"VALUE","challenge":"VALUE","tried":"VALUE","success":"VALUE","budget":"VALUE","email":"VALUE"}</INTAKE_COMPLETE>

Replace VALUE with the actual answers collected. The <INTAKE_COMPLETE> tag must be the very last thing in your response.

CONTACT: manish@manishmadan.net`;

// Derive current step from conversation length.
// History layout: [priming_user(0), priming_assistant(1), user1(2), bot1(3), user2(4)...]
// After receiving the Nth real user message the bot is about to ask Q(N+1).
// Real user messages are at even indices starting from 2: index 2,4,6,8,10,12
// N = (messages.length - 2) / 2  →  next question = N + 1, capped at 6.
function deriveStep(messages) {
  const realUserCount = Math.max(0, Math.floor((messages.length - 2) / 2));
  return Math.min(realUserCount + 1, 6);
}

function parseIntakeResponse(raw, messages) {
  // Extract INTAKE_COMPLETE if present
  const completeMatch = raw.match(/<INTAKE_COMPLETE>([\s\S]*?)<\/INTAKE_COMPLETE>/);

  // Strip any markers from visible reply
  let reply = raw
    .replace(/<INTAKE_STEP>\d+<\/INTAKE_STEP>/g, '')
    .replace(/<INTAKE_COMPLETE>[\s\S]*?<\/INTAKE_COMPLETE>/g, '')
    .trim();

  const result = { reply };

  if (completeMatch) {
    result.intake_complete = true;
    try {
      result.intake_data = JSON.parse(completeMatch[1].trim());
    } catch {
      result.intake_data = { raw: completeMatch[1].trim() };
    }
  } else {
    result.intake_step = deriveStep(messages);
  }

  return result;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, mode } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const isIntake = mode === 'intake';
  const systemPrompt = isIntake ? INTAKE_SYSTEM_PROMPT : QA_SYSTEM_PROMPT;
  const maxTokens = isIntake ? 350 : 200;

  // For intake, prepend a priming exchange so the model knows it's already
  // committed to the intake protocol before it sees the real conversation.
  const primedMessages = isIntake
    ? [
        { role: 'user',      content: 'Start the proposal intake.' },
        { role: 'assistant', content: 'Absolutely — I\'ll walk you through a few quick questions so we can put together something tailored to your situation. Let\'s start at the beginning: what does your company do? Even a sentence or two on the industry, size, and where you are in your journey helps me set the right context.<INTAKE_STEP>1</INTAKE_STEP>' },
        ...messages,
      ]
    : messages;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://manishmadan.net',
        'X-Title': 'Manish Madan Website',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages: [
          { role: 'system', content: systemPrompt },
          ...primedMessages,
        ],
        max_tokens: maxTokens,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('OpenRouter error:', err);
      return res.status(502).json({ error: 'Upstream API error' });
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content ?? '';

    if (!raw) {
      return res.json({ reply: "Sorry, I couldn't get a response. Reach out at manish@manishmadan.net." });
    }

    if (isIntake) {
      res.json(parseIntakeResponse(raw, primedMessages));
    } else {
      res.json({ reply: raw });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};
