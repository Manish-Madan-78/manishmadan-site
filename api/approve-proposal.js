'use strict';
require('dotenv').config();

const { getPendingProposal, updatePendingProposal } = require('./_store');
const { renderProposalPdf, sanitizeForPdf } = require('./generate-proposal');

// ── Send proposal email to visitor ──────────────────────────────────────────

async function sendToVisitor(proposal) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { success: false, error: 'RESEND_API_KEY not configured' };

  const payload = {
    from: 'Manish Madan <onboarding@resend.dev>',
    to: proposal.visitor_email,
    subject: proposal.email_subject,
    text: proposal.email_body,
  };
  if (proposal.proposal_pdf_base64) {
    payload.attachments = [{ filename: 'proposal.pdf', content: proposal.proposal_pdf_base64 }];
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error (send to visitor):', err);
    return { success: false, error: `Resend error: ${res.status}` };
  }
  return { success: true };
}

// ── Send Telegram confirmation after approval ────────────────────────────────

async function sendTelegramConfirmation(proposal) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_USER_ID;
  if (!botToken || !chatId) return;

  const msg = `✅ PROPOSAL SENT\n\n${proposal.visitor_name || 'Visitor'} at ${proposal.company_name || '(unknown)'}\nEmail: ${proposal.visitor_email}\nScore: ${proposal.lead_score || 'N/A'}`;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: msg }),
  }).catch(e => console.error('Telegram confirmation failed:', e.message));
}

// ── Revision agent — re-renders PDF with updated sections ───────────────────

async function runRevision(proposal, instructions) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

  const REVISION_TOOLS = [{
    type: 'function',
    function: {
      name: 'render_proposal_pdf',
      description: 'Renders a branded proposal PDF. Returns base64-encoded PDF data.',
      parameters: {
        type: 'object',
        properties: {
          company_name: { type: 'string' },
          contact_name: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: { heading: { type: 'string' }, body: { type: 'string' } },
              required: ['heading', 'body'],
            },
          },
        },
        required: ['company_name', 'contact_name', 'sections'],
      },
    },
  }];

  const systemPrompt = `You are revising a proposal on behalf of Manish Madan.
You will receive the original proposal email body and revision instructions.
Rewrite the proposal sections accordingly, keeping Manish's voice: warm, direct, specific, no corporate speak.
When ready, call render_proposal_pdf with the revised sections.`;

  const intakeRaw = proposal.intake_data?.raw || '(intake data not available)';
  const userMsg = `Original intake context:\n${intakeRaw}\n\nCurrent proposal email:\n${proposal.email_body}\n\nRevision instructions:\n${instructions}\n\nPlease revise and call render_proposal_pdf with the updated content.`;

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMsg },
  ];

  let newPdfBase64 = null;
  let newEmailBody = proposal.email_body;

  for (let turn = 1; turn <= 3; turn++) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-4-5',
        messages,
        tools: REVISION_TOOLS,
        max_tokens: 4096,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenRouter error: ${response.status} ${err}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    if (!choice) break;

    const assistantMessage = choice.message;
    messages.push(assistantMessage);

    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) break;

    for (const toolCall of assistantMessage.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments);

      if (toolCall.function.name === 'render_proposal_pdf') {
        const result = await renderProposalPdf(args);
        // renderProposalPdf sets module-level proposalPdfBase64 internally,
        // but we also need to capture it here. Re-export workaround:
        // The function returns {success, pages, size_kb} — we need the PDF bytes.
        // Since we share the module, proposalPdfBase64 is set on the generate-proposal module.
        // Access it via the shared module reference.
        const genModule = require('./generate-proposal');
        // We call renderProposalPdf which sets the module-level var — read it back via a fresh render
        // Actually: renderProposalPdf sets proposalPdfBase64 inside generate-proposal.js scope.
        // We need to re-render here directly to capture the bytes.
        const { PDFDocument: PDFDoc, rgb: rgbFn, StandardFonts: SF } = require('pdf-lib');
        const pdf2 = await PDFDoc.create();
        const font2 = await pdf2.embedFont(SF.Helvetica);
        const fontBold2 = await pdf2.embedFont(SF.HelveticaBold);
        const brandPrimary = rgbFn(0.18, 0.43, 0.64);
        const brandAccent  = rgbFn(0.12, 0.23, 0.36);
        const black = rgbFn(0.12, 0.13, 0.19);
        const gray  = rgbFn(0.35, 0.36, 0.43);

        const cn = sanitizeForPdf(args.company_name);
        const ct = sanitizeForPdf(args.contact_name);
        const secs = args.sections.map(s => ({ heading: sanitizeForPdf(s.heading), body: sanitizeForPdf(s.body) }));

        const cover = pdf2.addPage([612, 792]);
        cover.drawRectangle({ x: 0, y: 692, width: 612, height: 100, color: brandPrimary });
        cover.drawText('Manish Madan', { x: 50, y: 732, size: 22, font: fontBold2, color: rgbFn(1, 1, 1) });
        cover.drawText('Portfolio & PMO Leadership', { x: 50, y: 710, size: 12, font: font2, color: rgbFn(0.8, 0.8, 0.8) });
        cover.drawText('REVISED PROPOSAL', { x: 50, y: 600, size: 36, font: fontBold2, color: brandPrimary });
        cover.drawText(`Prepared for ${ct}`, { x: 50, y: 565, size: 16, font: font2, color: black });
        cover.drawText(cn, { x: 50, y: 542, size: 14, font: font2, color: gray });
        cover.drawText(new Date().toLocaleDateString('en-IN', { year: 'numeric', month: 'long', day: 'numeric' }), { x: 50, y: 510, size: 12, font: font2, color: gray });

        let y = 720;
        let page = pdf2.addPage([612, 792]);
        const maxWidth = 500;

        function drawLine(text, opts) {
          if (y < 60) { page = pdf2.addPage([612, 792]); y = 720; }
          page.drawText(text, { x: 50, y, ...opts });
          y -= opts.lineHeight || 18;
        }

        for (const sec of secs) {
          if (y < 120) { page = pdf2.addPage([612, 792]); y = 720; }
          page.drawLine({ start: { x: 50, y: y + 20 }, end: { x: 120, y: y + 20 }, thickness: 2, color: brandAccent });
          drawLine(sec.heading, { size: 16, font: fontBold2, color: brandPrimary, lineHeight: 28 });
          for (const paragraph of sec.body.split('\n')) {
            if (paragraph.trim() === '') { y -= 10; continue; }
            const words = paragraph.split(' ');
            let line = '';
            for (const word of words) {
              const testLine = line ? `${line} ${word}` : word;
              if (font2.widthOfTextAtSize(testLine, 11) > maxWidth && line) {
                drawLine(line, { size: 11, font: font2, color: black });
                line = word;
              } else { line = testLine; }
            }
            if (line) drawLine(line, { size: 11, font: font2, color: black });
          }
          y -= 20;
        }

        const lastPage = pdf2.getPages()[pdf2.getPageCount() - 1];
        lastPage.drawText('manish@manishmadan.net   |   linkedin.com/in/madmanu   |   manishmadan.net', { x: 50, y: 30, size: 9, font: font2, color: gray });

        const pdfBytes = await pdf2.save();
        newPdfBase64 = Buffer.from(pdfBytes).toString('base64');
        newEmailBody = instructions
          ? `${proposal.email_body}\n\n[Revised per your feedback: ${instructions}]`
          : proposal.email_body;

        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify({ success: true }) });
      }
    }

    if (newPdfBase64) break;
  }

  if (!newPdfBase64) throw new Error('Revision agent did not produce a PDF');
  return { pdf: newPdfBase64, body: newEmailBody, subject: proposal.email_subject };
}

// ── Approval page HTML ───────────────────────────────────────────────────────

function buildApprovalPage(proposal, notice = null) {
  const score = proposal.lead_score || 'PENDING';
  const scoreClass = ['HIGH', 'MEDIUM', 'LOW'].includes(score) ? `score-${score}` : 'score-PENDING';
  const noticeHtml = notice
    ? `<div class="notice">${escHtml(notice)}</div>`
    : '';
  const statusBadge = proposal.status === 'approved'
    ? '<span class="badge approved">SENT</span>'
    : '<span class="badge">PENDING REVIEW</span>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Review Proposal — Manish Madan</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f7f6f2;color:#1e2030;min-height:100vh}
    .header{background:#1a3a5c;color:#fff;padding:1.1rem 2rem;display:flex;align-items:center;gap:.75rem}
    .header h1{font-size:1rem;font-weight:600;letter-spacing:.01em}
    .badge{background:#e53e3e;color:#fff;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;letter-spacing:.05em;text-transform:uppercase}
    .badge.approved{background:#38a169}
    .container{max-width:700px;margin:2rem auto;padding:0 1.25rem}
    .card{background:#fff;border:1px solid #dddbd5;border-radius:12px;padding:1.5rem;margin-bottom:1.25rem}
    .card-label{font-size:.72rem;font-weight:700;color:#5a5c6e;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.9rem}
    .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
    .meta-item label{display:block;font-size:.75rem;color:#5a5c6e;margin-bottom:.15rem}
    .meta-item span{font-size:.95rem;font-weight:500}
    .score{display:inline-block;padding:.2rem .65rem;border-radius:999px;font-size:.8rem;font-weight:700}
    .score-HIGH{background:#c6f6d5;color:#276749}
    .score-MEDIUM{background:#feebc8;color:#7b341e}
    .score-LOW{background:#fed7d7;color:#742a2a}
    .score-PENDING{background:#e2e8f0;color:#4a5568}
    .email-preview{background:#f7f6f2;border-radius:8px;padding:1.1rem;font-size:.875rem;line-height:1.75;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto}
    .actions{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:1.25rem}
    .btn{padding:.65rem 1.4rem;border-radius:8px;border:none;font-size:.9rem;font-weight:600;cursor:pointer;transition:opacity .15s}
    .btn:hover{opacity:.82}
    .btn:disabled{opacity:.45;cursor:not-allowed}
    .btn-approve{background:#2e6da4;color:#fff}
    .btn-revise{background:#1a3a5c;color:#fff}
    .revise-form{display:none;margin-top:1.1rem;border-top:1px solid #dddbd5;padding-top:1.1rem}
    .revise-form.open{display:block}
    textarea{width:100%;padding:.7rem;border:1.5px solid #dddbd5;border-radius:8px;font-family:inherit;font-size:.875rem;line-height:1.6;resize:vertical;margin-bottom:.65rem}
    .notice{background:#ebf8ff;border:1px solid #bee3f8;border-radius:8px;padding:.9rem 1.1rem;font-size:.875rem;color:#2c5282;margin-bottom:1.25rem}
    .notice.success{background:#f0fff4;border-color:#9ae6b4;color:#276749}
    .spinner{display:none;margin-left:.5rem;font-size:.8rem;color:#5a5c6e}
  </style>
</head>
<body>
  <div class="header">
    <h1>Proposal Review — Manish Madan</h1>
    ${statusBadge}
  </div>
  <div class="container">
    ${noticeHtml}
    <div class="card">
      <div class="card-label">Lead Summary</div>
      <div class="meta-grid">
        <div class="meta-item"><label>Name</label><span>${escHtml(proposal.visitor_name || '—')}</span></div>
        <div class="meta-item"><label>Company</label><span>${escHtml(proposal.company_name || '—')}</span></div>
        <div class="meta-item"><label>Email</label><span>${escHtml(proposal.visitor_email || '—')}</span></div>
        <div class="meta-item"><label>Lead Score</label><span class="score ${scoreClass}">${escHtml(score)}</span></div>
      </div>
    </div>
    <div class="card">
      <div class="card-label">Proposal Email Preview</div>
      <div class="email-preview">${escHtml(proposal.email_body || '(no preview available)')}</div>
    </div>
    ${proposal.status !== 'approved' ? `
    <div class="card">
      <div class="card-label">Actions</div>
      <div class="actions">
        <button class="btn btn-approve" id="approveBtn">Approve &amp; Send to Visitor</button>
        <button class="btn btn-revise" id="reviseToggle">Request Changes</button>
        <span class="spinner" id="spinner">Working…</span>
      </div>
      <div class="revise-form" id="reviseForm">
        <textarea id="reviseInstructions" rows="4" placeholder="Describe what to change — tone, specific section, pricing, anything…"></textarea>
        <button class="btn btn-revise" id="submitRevise">Regenerate Proposal</button>
      </div>
    </div>
    ` : '<div class="card"><div class="notice success">This proposal has been sent to the visitor.</div></div>'}
  </div>
  <script>
    const id = new URLSearchParams(location.search).get('id');
    const spinner = document.getElementById('spinner');

    function setWorking(on) {
      if (spinner) spinner.style.display = on ? 'inline' : 'none';
      ['approveBtn','reviseToggle','submitRevise'].forEach(bid => {
        const b = document.getElementById(bid);
        if (b) b.disabled = on;
      });
    }

    const approveBtn = document.getElementById('approveBtn');
    if (approveBtn) {
      approveBtn.addEventListener('click', async () => {
        if (!confirm('Send this proposal to the visitor now?')) return;
        setWorking(true);
        const r = await fetch('/api/approve-proposal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'approve', id }),
        });
        if (r.ok) { location.reload(); }
        else { alert('Something went wrong. Check the server logs.'); setWorking(false); }
      });
    }

    const reviseToggle = document.getElementById('reviseToggle');
    const reviseForm = document.getElementById('reviseForm');
    if (reviseToggle && reviseForm) {
      reviseToggle.addEventListener('click', () => reviseForm.classList.toggle('open'));
    }

    const submitRevise = document.getElementById('submitRevise');
    if (submitRevise) {
      submitRevise.addEventListener('click', async () => {
        const instructions = document.getElementById('reviseInstructions').value.trim();
        if (!instructions) { alert('Please describe what to change.'); return; }
        setWorking(true);
        const r = await fetch('/api/approve-proposal', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'revise', id, instructions }),
        });
        if (r.ok) { location.reload(); }
        else { alert('Revision failed. Check the server logs.'); setWorking(false); }
      });
    }
  </script>
</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const id = req.query?.id || req.body?.id;

  // GET — show approval page
  if (req.method === 'GET') {
    if (!id) return res.status(400).send('Missing proposal ID');
    let proposal;
    try { proposal = await getPendingProposal(id); }
    catch (e) { return res.status(500).send(`Store error: ${e.message}`); }
    if (!proposal) return res.status(404).send('Proposal not found or already processed.');
    return res.send(buildApprovalPage(proposal));
  }

  // POST — approve or revise
  if (req.method === 'POST') {
    const { action, instructions } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Missing id' });

    let proposal;
    try { proposal = await getPendingProposal(id); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    if (!proposal) return res.status(404).json({ error: 'Proposal not found' });

    if (action === 'approve') {
      const result = await sendToVisitor(proposal);
      if (!result.success) return res.status(500).json({ error: result.error });
      await updatePendingProposal(id, { status: 'approved' });
      await sendTelegramConfirmation(proposal);
      console.log(`Proposal ${id} approved and sent to ${proposal.visitor_email}`);
      return res.json({ success: true });
    }

    if (action === 'revise') {
      if (!instructions) return res.status(400).json({ error: 'instructions required for revise' });
      let revised;
      try { revised = await runRevision(proposal, instructions); }
      catch (e) {
        console.error('Revision failed:', e.message);
        return res.status(500).json({ error: e.message });
      }
      await updatePendingProposal(id, {
        proposal_pdf_base64: revised.pdf,
        email_body: revised.body,
        email_subject: revised.subject,
        revision_instructions: instructions,
        status: 'revised',
      });
      console.log(`Proposal ${id} revised`);
      return res.json({ success: true });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
