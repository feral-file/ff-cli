import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildIntentParserSystemPrompt } from '../src/intent-parser';

describe('intent parser requirement guidance', () => {
  test('keeps contract guidance under build_playlist, not feral_file_artwork', () => {
    const prompt = buildIntentParserSystemPrompt();
    const buildSection = sectionBetween(prompt, '- build_playlist:', '- feral_file_artwork:');
    const feralFileSection = sectionBetween(prompt, '- feral_file_artwork:', '- query_address:');

    assert.match(buildSection, /USE THIS when user mentions "contract" with a quantity/);
    assert.match(buildSection, /"100 items from ethereum contract 0xABC" → build_playlist/);
    assert.match(feralFileSection, /feralfile\.com\/exhibitions\/artwork/);
    assert.match(feralFileSection, /Do not use this for ordinary blockchain contract prompts/);
    assert.doesNotMatch(feralFileSection, /N items from \[blockchain\] contract/);
    assert.doesNotMatch(feralFileSection, /"100 items from ethereum contract 0xABC"/);
  });
});

/**
 * sectionBetween extracts a prompt section bounded by stable headings.
 *
 * @param text - Prompt text to inspect.
 * @param start - Inclusive section start marker.
 * @param end - Exclusive section end marker.
 * @returns Extracted section text.
 */
function sectionBetween(text: string, start: string, end: string): string {
  const startIndex = text.indexOf(start);
  assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
  const endIndex = text.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
  return text.slice(startIndex, endIndex);
}
