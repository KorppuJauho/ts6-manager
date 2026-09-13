import { describe, it, expect } from 'vitest';

/**
 * Pure replica of BotEngine.handleDiscordMessage matching logic, so it can be
 * unit-tested without the full engine. Kept in sync with engine.ts.
 */
function matchDiscordFlows(
  flows: Array<{ id: number; triggerNodes: Array<{ id: string; data: any }> }>,
  msg: { channelId: string; content: string },
): Array<{ flowId: number; nodeId: string }> {
  const hits: Array<{ flowId: number; nodeId: string }> = [];
  for (const flow of flows) {
    for (const t of flow.triggerNodes) {
      const td = t.data;
      if (td?.triggerType !== 'discordMessage') continue;
      if (td.channelId && String(td.channelId) !== msg.channelId) continue;
      if (td.prefix && !msg.content.startsWith(td.prefix)) continue;
      hits.push({ flowId: flow.id, nodeId: t.id });
    }
  }
  return hits;
}

const flows = [
  { id: 1, triggerNodes: [{ id: 'a', data: { triggerType: 'discordMessage', channelId: '100', prefix: '!' } }] },
  { id: 2, triggerNodes: [{ id: 'b', data: { triggerType: 'discordMessage', channelId: '200' } }] },
  { id: 3, triggerNodes: [{ id: 'c', data: { triggerType: 'event', eventName: 'x' } }] },
];

describe('discord message → flow matching', () => {
  it('matches channel + prefix', () => {
    expect(matchDiscordFlows(flows, { channelId: '100', content: '!ping' })).toEqual([{ flowId: 1, nodeId: 'a' }]);
  });

  it('skips when the prefix does not match', () => {
    expect(matchDiscordFlows(flows, { channelId: '100', content: 'hello' })).toEqual([]);
  });

  it('matches any message in a channel with no prefix', () => {
    expect(matchDiscordFlows(flows, { channelId: '200', content: 'whatever' })).toEqual([{ flowId: 2, nodeId: 'b' }]);
  });

  it('ignores other channels and non-discord triggers', () => {
    expect(matchDiscordFlows(flows, { channelId: '999', content: '!ping' })).toEqual([]);
  });
});
