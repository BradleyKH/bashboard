import { describe, expect, it } from 'vitest';
import {
  EDITOR_SAVE_DELAY_MS,
  editorStep,
  initialEditorState,
  isDirty,
  type EditorEvent,
  type EditorState,
} from './textEditorModel';

function run(s: EditorState, ...events: EditorEvent[]): EditorState {
  return events.reduce((acc, e) => editorStep(acc, e).state, s);
}

const fresh = () => initialEditorState('hello', 100);

describe('edit', () => {
  it('schedules a save one second out', () => {
    const step = editorStep(fresh(), { type: 'edit', text: 'hello!' });
    expect(step.effects).toEqual([{ type: 'schedule', ms: EDITOR_SAVE_DELAY_MS }]);
    expect(EDITOR_SAVE_DELAY_MS).toBe(1000);
    expect(isDirty(step.state)).toBe(true);
  });

  it('cancels the timer when the text returns to what is saved', () => {
    const s = run(fresh(), { type: 'edit', text: 'x' });
    expect(editorStep(s, { type: 'edit', text: 'hello' }).effects).toEqual([{ type: 'cancel' }]);
  });

  it('keeps no timer while the conflict bar is up', () => {
    const s = { ...fresh(), conflict: true };
    expect(editorStep(s, { type: 'edit', text: 'x' }).effects).toEqual([]);
  });
});

describe('saving', () => {
  it('saves with the last modified time', () => {
    const s = run(fresh(), { type: 'edit', text: 'new' });
    const step = editorStep(s, { type: 'saveRequested' });
    expect(step.effects).toEqual([{ type: 'cancel' }, { type: 'save', text: 'new', expectedModified: 100 }]);
    expect(step.state.saving).toBe(true);
  });

  it('does nothing when there is nothing to save', () => {
    expect(editorStep(fresh(), { type: 'saveRequested' }).effects).toEqual([]);
  });

  it('records the new modified time on success', () => {
    const s = run(fresh(), { type: 'edit', text: 'new' }, { type: 'saveRequested' }, { type: 'saved', modified: 200 });
    expect(s).toMatchObject({ savedText: 'new', modified: 200, saving: false });
    expect(isDirty(s)).toBe(false);
  });

  it('never starts a second save while one is in flight, then saves again once', () => {
    let s = run(fresh(), { type: 'edit', text: 'one' }, { type: 'saveRequested' });
    s = run(s, { type: 'edit', text: 'two' });
    const blocked = editorStep(s, { type: 'saveRequested' });
    expect(blocked.effects).toEqual([]);
    const done = editorStep(blocked.state, { type: 'saved', modified: 200 });
    expect(done.effects).toEqual([{ type: 'cancel' }, { type: 'save', text: 'two', expectedModified: 200 }]);
    expect(done.state.saving).toBe(true);
    const last = editorStep(done.state, { type: 'saved', modified: 300 });
    expect(last.effects).toEqual([]);
    expect(isDirty(last.state)).toBe(false);
  });

  it('raises the bar on a conflicting save and holds further saves', () => {
    let s = run(fresh(), { type: 'edit', text: 'new' }, { type: 'saveRequested' });
    s = run(s, { type: 'saveFailed', conflict: true });
    expect(s).toMatchObject({ conflict: true, saving: false });
    expect(editorStep(s, { type: 'saveRequested' }).effects).toEqual([]);
  });

  it('stays dirty without a bar on another failure', () => {
    const s = run(fresh(), { type: 'edit', text: 'new' }, { type: 'saveRequested' }, { type: 'saveFailed', conflict: false });
    expect(s.conflict).toBe(false);
    expect(isDirty(s)).toBe(true);
    expect(editorStep(s, { type: 'saveRequested' }).effects).toHaveLength(2);
  });
});

describe('disk changes', () => {
  it('reloads in place when there are no unsaved edits', () => {
    const step = editorStep(fresh(), { type: 'diskChanged', modified: 150 });
    expect(step.effects).toContainEqual({ type: 'reload' });
    const done = editorStep(step.state, { type: 'reloaded', text: 'from disk', modified: 150 });
    expect(done.state).toMatchObject({ text: 'from disk', savedText: 'from disk', modified: 150, conflict: false });
    expect(done.effects).toContainEqual({ type: 'setText', text: 'from disk' });
  });

  it('never raises the bar on a clean editor, whatever the disk holds', () => {
    const touched = run(fresh(), { type: 'diskChanged', modified: 150 }, { type: 'reloaded', text: 'hello', modified: 150 });
    expect(touched).toMatchObject({ conflict: false, modified: 150, text: 'hello' });
    const changed = run(touched, { type: 'diskChanged', modified: 160 }, { type: 'reloaded', text: 'other', modified: 160 });
    expect(changed).toMatchObject({ conflict: false, modified: 160, text: 'other', savedText: 'other' });
    expect(editorStep(changed, { type: 'diskChanged', modified: 160 }).effects).toEqual([]);
  });

  it('checks the disk before raising the bar over unsaved edits', () => {
    const s = run(fresh(), { type: 'edit', text: 'mine' });
    const step = editorStep(s, { type: 'diskChanged', modified: 150 });
    expect(step.effects).toEqual([{ type: 'cancel' }, { type: 'reload' }]);
    expect(step.state).toMatchObject({ conflict: false, reloading: true, text: 'mine' });
    expect(editorStep(step.state, { type: 'saveRequested' }).effects).toEqual([]);
    const done = editorStep(step.state, { type: 'reloaded', text: 'theirs', modified: 150 });
    expect(done.state).toMatchObject({ conflict: true, text: 'mine', reloading: false });
  });

  it('keeps unsaved edits without a bar when only the modified time moved', () => {
    const s = run(fresh(), { type: 'edit', text: 'mine' }, { type: 'diskChanged', modified: 150 });
    const done = editorStep(s, { type: 'reloaded', text: 'hello', modified: 150 });
    expect(done.state).toMatchObject({ conflict: false, text: 'mine', savedText: 'hello', modified: 150 });
    expect(done.effects).toEqual([{ type: 'schedule', ms: EDITOR_SAVE_DELAY_MS }]);
  });

  it('counts edits that match the disk as saved', () => {
    const s = run(fresh(), { type: 'edit', text: 'same' }, { type: 'diskChanged', modified: 150 });
    const done = editorStep(s, { type: 'reloaded', text: 'same', modified: 150 });
    expect(done.state).toMatchObject({ conflict: false, modified: 150 });
    expect(isDirty(done.state)).toBe(false);
  });

  it('resumes saving when the check read fails', () => {
    const s = run(fresh(), { type: 'edit', text: 'mine' }, { type: 'diskChanged', modified: 150 });
    const step = editorStep(s, { type: 'reloadFailed' });
    expect(step.state.reloading).toBe(false);
    expect(step.effects).toEqual([{ type: 'schedule', ms: EDITOR_SAVE_DELAY_MS }]);
  });

  it('ignores the echo of its own save and changes during a save', () => {
    expect(editorStep(fresh(), { type: 'diskChanged', modified: 100 }).effects).toEqual([]);
    const saving = run(fresh(), { type: 'edit', text: 'x' }, { type: 'saveRequested' });
    expect(editorStep(saving, { type: 'diskChanged', modified: 150 }).state).toBe(saving);
  });

  it('does not discard edits typed while a reload was pending', () => {
    const pending = editorStep(fresh(), { type: 'diskChanged', modified: 150 }).state;
    const typed = run(pending, { type: 'edit', text: 'typed' });
    const done = editorStep(typed, { type: 'reloaded', text: 'disk', modified: 150 });
    expect(done.state).toMatchObject({ text: 'typed', conflict: true });
  });
});

describe('conflict bar', () => {
  const conflicted = () =>
    run(
      fresh(),
      { type: 'edit', text: 'mine' },
      { type: 'diskChanged', modified: 150 },
      { type: 'reloaded', text: 'disk', modified: 150 },
    );

  it('Reload discards edits', () => {
    const step = editorStep(conflicted(), { type: 'reloaded', text: 'disk2', modified: 160 });
    expect(step.state).toMatchObject({ text: 'disk2', conflict: false, modified: 160 });
    expect(isDirty(step.state)).toBe(false);
  });

  it('Keep mine saves over the file with the fresh modified time', () => {
    const step = editorStep(conflicted(), { type: 'keepMine', modified: 150 });
    expect(step.effects).toEqual([{ type: 'cancel' }, { type: 'save', text: 'mine', expectedModified: 150 }]);
    expect(step.state).toMatchObject({ conflict: false, saving: true });
  });
});
