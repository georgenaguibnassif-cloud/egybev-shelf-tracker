const Anthropic = require('@anthropic-ai/sdk');

// Vercel's request body cap is 4.5MB. Base64 inflates a file by ~4/3, so the raw
// file must stay under ~3.3MB — the client caps uploads at 3MB to stay clear of it.
const MAX_BASE64_CHARS = 4_400_000;

const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const PDF_MEDIA_TYPE = 'application/pdf';

// The client (Share_of_Shelf_Tracker.html, applyScannedItems) only reads `sku` and
// `price` — it resolves side/category itself by fuzzy-matching the SKU name against
// EGYBEV_CATALOG and HEINEKEN_CATALOG. So this endpoint's whole job is faithful
// transcription: read what the menu says, don't classify it.
const EXTRACTION_PROMPT = `Extract every alcoholic drink listed on this menu.

For each one return:
- "sku": the drink name exactly as printed on the menu. Keep the producer/brand
  wording and any varietal or size descriptor that appears in the name. Do not
  translate, expand, correct, or normalise it — a downstream step matches these
  against a product catalogue and needs the menu's own wording.
- "price": the numeric price, no currency symbol or separators (e.g. 1250, not
  "EGP 1,250"). Use null when no price is printed.

Rules:
- One entry per distinct listing. If the same drink appears in two sizes or two
  vintages, that is two entries.
- When a listing shows both a bottle price and a by-the-glass price, return the
  BOTTLE price. Never return the glass price when a bottle price is present.
- Include wine, sparkling wine, beer, spirits, liqueurs, and cocktails.
- Exclude soft drinks, water, juice, coffee, tea, and food.
- Read the whole menu, including multi-column layouts and continuation pages.
- If the image is unreadable or contains no drinks menu, return an empty list.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sku: { type: 'string' },
          price: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
        required: ['sku', 'price'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Menu scanning is not configured — ANTHROPIC_API_KEY is missing.',
    });
  }

  const body = req.body || {};
  const { mediaType, data } = body;

  if (typeof mediaType !== 'string' || typeof data !== 'string' || !data) {
    return badRequest(res, 'Expected a JSON body with "mediaType" and base64 "data".');
  }

  const isPdf = mediaType === PDF_MEDIA_TYPE;
  if (!isPdf && !IMAGE_MEDIA_TYPES.includes(mediaType)) {
    return badRequest(res, `Unsupported file type: ${mediaType}.`);
  }

  if (data.length > MAX_BASE64_CHARS) {
    return badRequest(res, 'That file is too large — try a photo instead of a PDF.');
  }

  // The client strips the "data:...;base64," prefix before sending. If something
  // upstream changes and it stops doing that, the API would reject the payload with
  // a less obvious error, so catch it here.
  if (data.startsWith('data:')) {
    return badRequest(res, 'Send raw base64 without the data-URL prefix.');
  }

  const source = { type: 'base64', media_type: mediaType, data };
  const fileBlock = isPdf
    ? { type: 'document', source }
    : { type: 'image', source };

  try {
    const client = new Anthropic();

    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
      max_tokens: 8000,
      output_config: {
        // Menus are dense but the task is transcription, not reasoning. Medium keeps
        // the round trip short enough for a rep scanning on a phone in an outlet.
        effort: 'medium',
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
      },
      messages: [
        { role: 'user', content: [fileBlock, { type: 'text', text: EXTRACTION_PROMPT }] },
      ],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'That file could not be processed.' });
    }
    if (response.stop_reason === 'max_tokens') {
      return res.status(502).json({
        error: 'That menu is too long to read in one pass — scan it a page at a time.',
      });
    }

    const textBlock = response.content.find(block => block.type === 'text');
    if (!textBlock) {
      return res.status(502).json({ error: 'No menu data came back — try again.' });
    }

    // output_config.format guarantees this parses and matches OUTPUT_SCHEMA.
    const { items } = JSON.parse(textBlock.text);

    return res.status(200).json({
      items: items.map(item => ({
        sku: item.sku,
        price: typeof item.price === 'number' && isFinite(item.price) ? item.price : null,
      })),
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      return res.status(429).json({ error: 'Too many scans at once — wait a moment and retry.' });
    }
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(500).json({ error: 'Menu scanning is misconfigured — the API key was rejected.' });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return res.status(504).json({ error: 'Could not reach the scanning service — check your connection.' });
    }
    if (err instanceof Anthropic.APIError) {
      console.error('extract-menu: Anthropic API error', err.status, err.message);
      return res.status(502).json({ error: 'The scanning service returned an error — try again.' });
    }
    console.error('extract-menu: unexpected error', err);
    return res.status(500).json({ error: 'Scan failed unexpectedly.' });
  }
};

// Reading a dense multi-page menu can take longer than Vercel's 10s default.
module.exports.config = { maxDuration: 60 };
