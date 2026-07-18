// Telegram's Bot API rejects a request that sets both `entities`/`caption_entities`
// AND `parse_mode` at once. If the admin pasted a custom/animated emoji (or native
// formatting) while setting the Text, we captured raw entities for it — those must
// be relayed as-is. Otherwise fall back to HTML parse_mode for manual <b>/<i> tags.
function buildTextOptions(job) {
  if (job.textEntities && job.textEntities.length) {
    return { entities: job.textEntities };
  }
  return { parse_mode: 'HTML' };
}

function buildCaptionOptions(job) {
  if (job.textEntities && job.textEntities.length) {
    return { caption_entities: job.textEntities };
  }
  return { parse_mode: 'HTML' };
}

module.exports = { buildTextOptions, buildCaptionOptions };
