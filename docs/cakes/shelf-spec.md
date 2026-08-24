# Cakes — the shelf owns the cake

Spec for three changes the E1–E10 pass surfaced. Written from the code as it
stands on `f49653f31`, not from memory: each "how it works today" line below was
read out of the source before the spec was drafted, and two of them contradict
what a reasonable person would assume.

Not published to a tracker: none is configured for this repository. This file
is the record.

## Problem statement

Three things a person meets while using cakes, in the order they meet them.

**A cake dropped on a new thread does nothing.** Drag a cake from the shelf
onto a thread that has not sent its first message, and the drop is swallowed.
No dialog, no error, no attachment. The user has no way to know whether the
gesture failed, the feature is broken, or the thread is somehow wrong — and the
honest answer is the third, which nothing says.

**A cake's model silently overrides the thread's.** Drop a Fable cake on a
thread the user deliberately set to Opus, and the cake's turn runs as Fable, in
that thread. The thread's chosen model was not preserved; it was replaced for
one turn by a setting made somewhere else. The user asked for Opus and got
Fable, and the composer still says Opus.

**Cakes live in two places.** They are made and edited in Settings → Cakes, and
used from the right sidebar's shelf. To rename a cake you are dragging, you
leave the thread, open Settings, find the row, open the dialog, come back. The
shelf shows a cake you cannot touch except to pick it up.

## Solution

**The drop always answers.** Dropping a cake on a thread that has not started
opens a dialog: _"Start `<cake>` now?"_ — with the cake's face inline, the way
the existing busy-thread dialog already does it. Confirming attaches the cake
and starts its first run on that thread; that first turn is what initiates the
session. Cancelling does nothing, and says so by closing.

**A model conflict forks, and the thread keeps its model.** When a cake's model
differs from a started thread's, the cake runs on a new forked thread seeded
with the cake's own model, and the original thread is untouched — its model,
its session, its history. This is what the fork already does for cross-driver
and for Grok; the change extends the same rule to any model difference. The
attached thread still owns the schedule; the forked thread is where the work
happens.

**The shelf is the only home a cake has.** Settings → Cakes is removed
entirely — the route, the nav entry, the search entries, the panel. Every row
on the shelf gains an ellipsis menu with Rename, Edit and Delete, opening the
same dialog Settings used. Creating stays where it already is (the header
button with cakes present, the label-only button when empty). The shelf is
where you make, use, change and remove a cake, and nowhere else is.

## User stories

1. As a user, I want a dropped cake to always produce a visible response, so that I never wonder whether the gesture worked.
2. As a user, I want to be asked before a cake starts on a fresh thread, so that an unattended agent never begins with nobody having said yes.
3. As a user, I want the "start now" dialog to show which cake it is, so that I confirm the right loop when I have several.
4. As a user, I want the thread's model to stay what I set it to, so that a cake never changes a decision I made about my own thread.
5. As a user, I want a cake with a different model to run on its own forked thread, so that its work happens somewhere I can see without disturbing where I am.
6. As a user, I want the fork to carry the cake's model and the thread's project, so that the forked run is the cake I configured, in the place I attached it.
7. As a user, I want the original thread to keep the schedule, so that the cake I attached keeps firing from where I put it even though its runs happen elsewhere.
8. As a user, I want to rename a cake from the shelf, so that I do not leave the thread to fix a label.
9. As a user, I want to edit a cake's schedule, model and instructions from the shelf, so that the shelf is where I manage cakes as well as use them.
10. As a user, I want to delete a cake from the shelf, so that a loop I no longer want is one click from gone.
11. As a user, I want deleting a cake to ask first, so that an unattended loop is not removed by a slipped click.
12. As a user, I want the ellipsis not to interfere with dragging, so that the shelf stays a palette I can pick from.
13. As a user, I want Settings to no longer have a Cakes section, so that there is one place to look and it is the shelf.
14. As a user, I want Settings search to no longer offer "Cakes", so that search does not send me to a page that is gone.
15. As a developer, I want every reference to the removed Settings page gone, so that the removal is complete rather than a page that still half-exists.
16. As a developer, I want the model-conflict fork rule to be tested with an Opus thread and a Fable cake, so that the case a user actually hits is the case that is pinned.

## Implementation decisions

### 1. The unstarted-thread drop

**How it works today.** `decideCakeDrop` returns `ignore` when `threadId` is
null. A draft thread has no id until its first message creates it, so a drop
on a draft is indistinguishable, to the decision, from a drop with no target.
That is the swallow.

**Decision.** The drop decision gains a third input, whether the thread has
started, and a fourth outcome: `ask-start`. It fires when a thread id exists
but no conversation has begun. The existing `ask` (busy thread) and `attach`
(idle, started thread) are unchanged.

A draft with no thread id at all stays `ignore` — there is genuinely nothing
to attach to, and the composer already hides the Cakes control there for that
reason. The gap this closes is the thread that _exists_ but has not spoken,
which is the state a thread is in the moment it is created and before the user
types.

**The dialog** reuses `CakeDropDialog`'s structure with different copy and one
choice instead of two. Confirming does what the existing attach-and-run path
does — attach, then run now — and the run's first turn initiates the session.
The dialog is presentational so its copy and its single choice are assertable.

**Why ask rather than just start.** A cake starts a full-access agent
unattended. On a busy thread the existing dialog exists because interrupting
silently would throw work away; on an empty thread the reason is the mirror
image — starting silently would begin work nobody confirmed. Both are the same
principle: nothing starts until someone picks.

### 2. Model conflict forks, thread model preserved

**How it works today — and this is the one that contradicts assumption.**
`decideCakeRunTarget` forks only when the drivers differ or when a provider
sets `requiresNewThreadForModelChange` (Grok alone). An Opus thread and a Fable
cake are the same driver, and Claude does not set the flag, so the answer is
`in-place`. The cake's turn then carries `modelSelection: { model: "fable" }`,
and `ProviderCommandReactor` honours it: the turn runs as Fable, in the Opus
thread. The thread's model is not changed as a setting, but it is overridden
for that turn, and the user is not told.

So the answer to "does it run as Opus or Fable?" is **Fable**, and the answer
to "is the thread's model preserved?" is **no, not for that turn.**

**Decision.** Same instance and same model still runs in place. Any other
difference forks. The capability flag stops being the deciding input: it was
answering "does the provider _forbid_ this change?", and the question the user
actually has is "did I _choose_ a different model for this thread?" — which any
difference answers yes.

The rule collapses from four branches to two:

- thread not started → in place (unchanged; forking an empty thread strands it)
- same instance and model → in place
- anything else → fork

`requiresNewThreadForModelChange` and the driver comparison become
unnecessary: both were special cases of "different", and "different" now
always forks. They are deleted rather than kept as dead branches.

**What the fork carries** is unchanged and already correct:
`buildCakeForkThreadCommand` copies `projectId`, `branch` and `worktreePath`
from the attached thread and seeds the new thread with the cake's provider and
model. The forked thread is attached with `nextRunAt: null` so the schedule
stays on the thread the user chose.

**The composer stays honest.** The attached thread's composer still reads its
own model, because nothing about it changed. The forked thread's composer reads
the cake's model, because that is the thread's model. No surface shows a model
that is not the one running.

### 3. The shelf owns the cake; Settings does not

**What Settings owns today**, from the source: the route
`routes/settings.cakes.tsx`; the panel `settings/CakesSettings.tsx`; an entry in
`SettingsSidebarNav.tsx`; three entries in `settingsSearch.ts` (the path union,
the section label, and a searchable item); and the `searchableSetting("cakes")`
anchor the panel registers. Six places. "Completely pruned" means all six, and
the acceptance test enumerates them.

**Decision.** All six are removed. `useCakeEditor` — which already exists,
already owns create/edit/delete, and is already used by the shelf for create —
becomes the shelf's editor for everything. Nothing is rebuilt; the panel was
the only consumer that goes away.

**The ellipsis menu** is a `Menu` from the design system, triggered by a
`MoreHorizontalIcon` button at the trailing edge of each row, the way
`PullRequestDetailPanel` already does it. Three items: Rename, Edit, Delete.
Rename opens the edit dialog with the name field focused rather than a separate
inline editor — one dialog, one code path, and the name is the first field in
it already. Delete asks first, in the dialog's own footer, which the edit
dialog already has.

**Drag and the ellipsis do not fight.** The trigger stops pointer-down
propagation so a press on it never begins a drag, and the row's `draggable`
stays on the row. Presentational, so "pressing the ellipsis does not start a
drag" is a test rather than a hope — the row can be rendered on its own.

**The Create button placement is unchanged.** It was decided and shipped
earlier and the empty-state copy no longer mentions Settings.

**What the shelf still does not do.** Run, Stop and the lock stay on the
composer's picker, because those are statements about a thread and the shelf
is not in one. That boundary was drawn earlier for a reason and this change
does not move it: the ellipsis is about the cake itself, which is exactly the
thing the shelf _is_ about.

### Order

1. **§3 first.** It is the largest and touches the most files, and it deletes
   a surface — better to do that before adding behaviour that surface might
   have referenced.
2. **§1 second.** Small, self-contained, and it changes the drop decision that
   §2's manual test depends on being visible.
3. **§2 last.** Two lines of decision logic and a test rewrite; lowest risk
   per line, highest consequence per line.

## Testing decisions

A good test here asserts what the user sees or what the server does, not how.
The drop decision, the run-target decision and the row's markup are all pure
or presentational, which is why they can be tested at all in a stack with no
DOM.

### §1 — drop on an unstarted thread

```
decideCakeDrop_asks_to_start_when_the_thread_exists_but_has_not_spoken
decideCakeDrop_still_ignores_a_drop_with_no_thread_at_all
decideCakeDrop_still_attaches_silently_to_a_started_idle_thread
decideCakeDrop_still_asks_fork_or_stop_on_a_busy_thread
cakeStartDialog_names_the_cake_it_is_about_to_start
cakeStartDialog_offers_exactly_one_way_to_say_yes
cakeStartDialog_cancel_starts_nothing
```

Prior art: `cakeDropDecision.test.ts` and `CakeDropChoices.test.tsx` already
test the sibling decision and dialog the same way.

### §2 — model conflict forks

```
decideCakeRunTarget_forks_an_opus_thread_for_a_fable_cake
decideCakeRunTarget_forks_any_model_difference_on_one_driver
decideCakeRunTarget_still_runs_in_place_on_the_same_model
decideCakeRunTarget_still_runs_in_place_on_an_unstarted_thread
forkedThread_carries_the_cakes_model_not_the_threads
attachedThread_keeps_its_model_after_the_cake_forks
```

The first is the user's exact question, as a test name. Prior art:
`cakeRunTarget.test.ts` — which must lose the case named "runs in place when
neither provider objects to a model change", because that case is the old
rule. The existing test that asserts a same-driver instance change does _not_
fork is the one a reviewer should look at hardest: under the new rule it
forks, and the test flips deliberately.

### §3 — the shelf owns the cake

```
shelfRow_offers_rename_edit_and_delete_by_name
shelfRow_ellipsis_does_not_start_a_drag
shelfRow_stays_draggable_with_the_menu_present
deleteFromShelf_asks_before_removing
settingsNav_has_no_cakes_entry
settingsSearch_offers_no_cakes_result
settingsRoutes_have_no_cakes_route
```

The last three are the pruning checklist as tests. Prior art:
`CakesSurface.test.tsx` renders the launcher and add-menu to catch an entry
missing from a plain array; these do the inverse for an entry that must be
absent. `ComposerCakeRow.test.tsx` already pins icon-only controls by their
accessible names, which is how the ellipsis and its three items are pinned.

### Manual, once

- **M1** Drop a cake on a brand-new thread → dialog → confirm → the thread's
  first turn is the cake's.
- **M2** Set a thread to Opus, drop a Fable cake, Start → a new thread appears
  running as Fable; the Opus thread's composer still reads Opus.
- **M3** From the shelf: rename a cake, see the new name; edit its schedule,
  see the new "Next run"; delete it, confirm, see it gone.
- **M4** Open Settings; there is no Cakes section, and searching "cake" finds
  nothing.

## Out of scope

- **Inline rename** (editing the name in place on the row). Rename opens the
  dialog. One code path; the name is already its first field.
- **Any change to Run / Stop / lock placement.** They stay on the composer's
  picker for the reason recorded when they were moved there.
- **The cwd-fallback hazard** (hazard 21). Separate, already specified.
- **A "run as the thread's model instead" option** in the conflict case. The
  cake's model is part of what the cake _is_; offering to override it would
  make the dialog a second model picker.

## Further notes

Item 2 is worth saying plainly because the current behaviour is easy to
mistake for correct: the cake _does_ run as its own model today, and nothing
is thrown. What is wrong is quieter than an error — a turn ran in a thread
under a model the thread's owner never chose, and the composer kept showing
the model they did. The fix is not to add a check but to delete two: the
driver comparison and the capability flag were both narrow answers to a
question that has one broad answer.

Item 3 deletes more than it adds. The editor hook already existed; the shelf
already used it for create. The work is removing a page and giving three
actions a home that was already built for them.
