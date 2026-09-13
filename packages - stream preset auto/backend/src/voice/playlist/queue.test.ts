import { describe, it, expect } from 'vitest';
import { PlayQueue, QueueItem } from './queue.js';

function makeItem(id: string): QueueItem {
  return { id, title: `Track ${id}`, filePath: `/music/${id}.mp3`, source: 'local' };
}

describe('PlayQueue', () => {
  describe('remove() in shuffle mode – Bug 1', () => {
    it('keeps current pointing at the same track after removing a track BEFORE it', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));
      q.add(makeItem('d'));

      // Enable shuffle with a known fixed shuffleOrder so we can reason about positions
      q.setShuffle(true);

      // Force a deterministic shuffle order by advancing until we are at position 1
      // (i.e. the second slot of whatever order was generated).
      // We do this by calling next() until currentIndex = 1.
      q.next(); // currentIndex -> 0
      q.next(); // currentIndex -> 1

      const currentTrack = q.current;
      expect(currentTrack).not.toBeNull();

      // Find a track that is BEFORE the current position in the display (shuffled) list
      const displayed = q.getAll();
      const currentDisplayPos = q.index; // shuffleOrder position = 1

      // Remove the track at display position 0 (before current)
      const trackToRemove = displayed[0];
      // Make sure we're not removing the current track itself
      expect(trackToRemove!.id).not.toBe(currentTrack!.id);

      q.remove(trackToRemove!.id);

      // currentIndex should have decremented by 1 (now = 0)
      expect(q.index).toBe(currentDisplayPos - 1);
      // And the track we were playing must still be current
      expect(q.current?.id).toBe(currentTrack!.id);
      // shuffleOrder must stay consistent with items length
      expect(q.length).toBe(3);
    });

    it('keeps current pointing at the same track after removing a track AFTER it', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));
      q.add(makeItem('d'));

      q.setShuffle(true);

      // Advance to position 0 (first track in shuffle order)
      q.next(); // currentIndex -> 0

      const currentTrack = q.current;
      expect(currentTrack).not.toBeNull();

      const displayed = q.getAll();
      // Remove the track at display position 2 (after current at 0)
      const trackToRemove = displayed[2];
      expect(trackToRemove!.id).not.toBe(currentTrack!.id);

      q.remove(trackToRemove!.id);

      // currentIndex should be unchanged (removed track was after it)
      expect(q.index).toBe(0);
      expect(q.current?.id).toBe(currentTrack!.id);
      expect(q.length).toBe(3);
    });

    it('clamps currentIndex when the current track itself is removed', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));
      q.add(makeItem('d'));

      q.setShuffle(true);

      // Advance to the last position in shuffleOrder (index 3)
      q.next();
      q.next();
      q.next();
      q.next(); // currentIndex -> 3

      const currentTrack = q.current;
      expect(currentTrack).not.toBeNull();
      expect(q.index).toBe(3);

      // Remove the currently playing track
      q.remove(currentTrack!.id);

      // After removal shuffleOrder.length = 3, so index should clamp to 2
      expect(q.index).toBe(2);
      expect(q.length).toBe(3);
    });

    it('shuffleOrder.length always equals items.length after remove', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));
      q.add(makeItem('d'));
      q.setShuffle(true);
      q.next();
      q.next();

      q.remove('a');
      expect(q.length).toBe(3);
      // Access private via cast for invariant check
      const qAny = q as any;
      expect(qAny.shuffleOrder.length).toBe(q.length);

      q.remove('b');
      expect(q.length).toBe(2);
      expect(qAny.shuffleOrder.length).toBe(q.length);
    });
  });

  describe('moveInDisplayOrder() – Bug 2', () => {
    it('reorders within shuffleOrder (not items) when shuffle is on', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));
      q.add(makeItem('d'));

      q.setShuffle(true);

      const displayBefore = q.getAll().map((t) => t.id);
      // Move the second display item to the first position
      const moved = q.moveInDisplayOrder(1, 0);
      expect(moved).toBe(true);

      const displayAfter = q.getAll().map((t) => t.id);
      // The track that was at position 1 is now at position 0
      expect(displayAfter[0]).toBe(displayBefore[1]);
      expect(displayAfter[1]).toBe(displayBefore[0]);

      // items[] order must be completely unchanged
      const qAny = q as any;
      const itemIds = (qAny.items as QueueItem[]).map((i) => i.id);
      expect(itemIds).toEqual(['a', 'b', 'c', 'd']);
    });

    it('updates currentIndex to follow the moved track (shuffle mode)', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));

      q.setShuffle(true);
      q.next(); // currentIndex -> 0

      const currentTrack = q.current;
      // Move item at display 0 to display 2
      q.moveInDisplayOrder(0, 2);
      // currentIndex should follow to position 2
      expect(q.index).toBe(2);
      expect(q.current?.id).toBe(currentTrack!.id);
    });

    it('delegates to items-space move when shuffle is off', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.add(makeItem('b'));
      q.add(makeItem('c'));

      q.next(); // currentIndex -> 0

      // Without shuffle, display order == items order
      q.moveInDisplayOrder(0, 2);
      expect(q.getAll().map((t) => t.id)).toEqual(['b', 'c', 'a']);
    });

    it('returns false for out-of-bounds indices', () => {
      const q = new PlayQueue();
      q.add(makeItem('a'));
      q.setShuffle(true);
      expect(q.moveInDisplayOrder(-1, 0)).toBe(false);
      expect(q.moveInDisplayOrder(0, 5)).toBe(false);
    });
  });
});
