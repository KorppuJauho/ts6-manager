import { describe, it, expect } from 'vitest';
import { diffAwayState, mapAwayClients, type AwayClient } from './away-diff.js';

const c = (clid: string, isAway: boolean, cid = '5', nickname = `U${clid}`): AwayClient => ({ clid, cid, isAway, nickname });

describe('diffAwayState', () => {
  it('amorce sans changement quand prev est vide', () => {
    const { changes, next, seeded } = diffAwayState(new Map(), [c('1', false), c('2', true)]);
    expect(seeded).toBe(true);
    expect(changes).toEqual([]);
    expect(next.get('1')).toBe(false);
    expect(next.get('2')).toBe(true);
  });

  it('détecte le passage AFK (false → true)', () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', true)]);
    expect(changes).toEqual([{ clid: '1', cid: '5', nickname: 'U1', isAway: true }]);
  });

  it('détecte le retour (true → false)', () => {
    const prev = new Map([['1', true]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes[0].isAway).toBe(false);
  });

  it("n'émet rien quand l'état est inchangé", () => {
    const prev = new Map([['1', false]]);
    const { changes } = diffAwayState(prev, [c('1', false)]);
    expect(changes).toEqual([]);
  });

  it("enregistre un nouveau client sans le notifier", () => {
    const prev = new Map([['1', false]]);
    const { changes, next } = diffAwayState(prev, [c('1', false), c('2', true)]);
    expect(changes).toEqual([]);
    expect(next.get('2')).toBe(true);
  });

  it('purge les clids disparus de la liste courante', () => {
    const prev = new Map([['1', false], ['2', true]]);
    const { next } = diffAwayState(prev, [c('1', false)]);
    expect(next.has('2')).toBe(false);
  });
});

describe('mapAwayClients', () => {
  it('filtre les clients dont client_type !== 0 (ex: query client type 1)', () => {
    const list = [
      { clid: '1', cid: '5', client_type: '0', client_away: '0', client_nickname: 'Alice' },
      { clid: '2', cid: '5', client_type: '1', client_away: '0', client_nickname: 'ServerQuery' },
    ];
    const result = mapAwayClients(list, null);
    expect(result).toEqual([{ clid: '1', cid: '5', isAway: false, nickname: 'Alice' }]);
  });

  it("avec un watchedChannel défini, ne garde que les clients dont le cid correspond", () => {
    const list = [
      { clid: '1', cid: '5', client_type: '0', client_away: '0', client_nickname: 'Alice' },
      { clid: '2', cid: '7', client_type: '0', client_away: '0', client_nickname: 'Bob' },
    ];
    const result = mapAwayClients(list, '5');
    expect(result).toEqual([{ clid: '1', cid: '5', isAway: false, nickname: 'Alice' }]);
  });

  it('avec watchedChannel null ou undefined, garde les clients de tous les canaux', () => {
    const list = [
      { clid: '1', cid: '5', client_type: '0', client_away: '0', client_nickname: 'Alice' },
      { clid: '2', cid: '7', client_type: '0', client_away: '0', client_nickname: 'Bob' },
    ];
    expect(mapAwayClients(list, null)).toHaveLength(2);
    expect(mapAwayClients(list, undefined)).toHaveLength(2);
  });

  it("parse client_away ('1' → isAway true, '0'/absent → false)", () => {
    const list = [
      { clid: '1', cid: '5', client_type: '0', client_away: '1', client_nickname: 'Alice' },
      { clid: '2', cid: '5', client_type: '0', client_away: '0', client_nickname: 'Bob' },
      { clid: '3', cid: '5', client_type: '0', client_nickname: 'Carol' },
    ];
    const result = mapAwayClients(list, null);
    expect(result.find((r) => r.clid === '1')?.isAway).toBe(true);
    expect(result.find((r) => r.clid === '2')?.isAway).toBe(false);
    expect(result.find((r) => r.clid === '3')?.isAway).toBe(false);
  });

  it("retombe sur 'Client #<clid>' quand client_nickname est absent ou vide", () => {
    const list = [
      { clid: '1', cid: '5', client_type: '0', client_away: '0' },
      { clid: '2', cid: '5', client_type: '0', client_away: '0', client_nickname: '' },
    ];
    const result = mapAwayClients(list, null);
    expect(result[0].nickname).toBe('Client #1');
    expect(result[1].nickname).toBe('Client #2');
  });

  it('retourne [] pour une entrée non tableau', () => {
    expect(mapAwayClients(undefined, null)).toEqual([]);
    expect(mapAwayClients(null, null)).toEqual([]);
    expect(mapAwayClients({}, null)).toEqual([]);
    expect(mapAwayClients('nope', null)).toEqual([]);
  });
});
