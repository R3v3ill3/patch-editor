---
name: Boundary Editing Modes
overview: Assess feasibility of implementing simultaneous shared boundary editing and gap creation modes for patch boundary updates, and propose both incremental improvements and potential full implementations.
todos: []
isProject: false
---

# Boundary Editing Enhancement Plan

## Current Workflow Analysis

The existing boundary editing system works as follows:

1. **Selection & Simplification**: User selects patch → adjusts simplification slider → optionally refines vertices manually
2. **Submission**: Applies changes to the selected patch geometry
3. **Post-Edit Analysis** ([geometry-edit.ts](src/lib/geometry-edit.ts)):
  - `analysePostEdit` detects neighboring patches via shared boundary matching (0.5m tolerance)
  - `generateBoundaryProposals` creates aligned geometries for each neighbor
  - Classifies relationships as gap/overlap/aligned
4. **Review & Alignment** ([AlignmentPreviewDialog.tsx](src/components/AlignmentPreviewDialog.tsx)):
  - Shows list of affected neighbors with visual preview
  - Users manually select which neighbors to align
  - Each neighbor can be individually edited if snap quality is poor
  - Batch apply updates

## User's Request: Two Editing Modes

**Mode 1: Linked Boundaries** - Drag a shared boundary and move BOTH patches simultaneously (maintain shared border)

**Mode 2: Independent Boundaries** - Move only the selected patch's boundary, explicitly creating gaps/unallocated space

## Feasibility Assessment

### Mode 2: Independent Boundaries (Gap Creation)

**Status**: ✅ Already Supported

This mode already exists - users simply don't align neighbors in the PostEditDialog. The gap detection system (`detectGap` function) identifies unallocated space and offers to create patches from it.

**Enhancement Needed**: Make the intent clearer in the UI

- Add explicit "Create Gap" toggle in SimplifyPanel
- When enabled, skip the neighbor alignment suggestions entirely
- Visual indicator on map showing gap will be created

**Complexity**: Low | **Risk**: None | **Effort**: 1-2 hours

### Mode 1: Linked Boundaries (Simultaneous Editing)

**Status**: ⚠️ Technically Feasible but Complex

**Technical Challenges**:

1. **Terra-draw Integration**: The vertex editing uses terra-draw's SelectMode ([DrawingTools.tsx](src/components/DrawingTools.tsx) lines 79-102). Terra-draw doesn't natively support editing multiple features simultaneously.
2. **Real-time Synchronization**: Would need to:
  - Intercept vertex drag events (currently logged lines 118-194)
  - Detect if dragged vertex is on a shared boundary
  - Find all neighboring patches sharing that vertex
  - Update their geometries in real-time during the drag
  - Handle edge cases (wrap-around boundaries, reversed segments)
3. **Performance**: With complex geometries (>12,000 vertices), the system already uses optimization strategies (see `analysePostEdit` lines 695-840). Real-time multi-patch updates could cause lag.
4. **Data Structure**: Current architecture treats each patch as independent. Shared boundaries are detected algorithmically, not structurally stored.

**Implementation Approaches**:

### Approach A: Post-Drag Synchronization (Recommended)

Instead of real-time updates, detect shared vertex movements after drag completes:

```typescript
// In DrawingTools.tsx, modify terra-draw change handler
draw.on('change', () => {
  if (linkedBoundaryMode && selectedVertex) {
    const movedVertex = getCurrentVertexPosition();
    const affectedNeighbors = findNeighborsWithVertex(originalVertex);
    affectedNeighbors.forEach(neighbor => {
      syncVertexInNeighbor(neighbor, originalVertex, movedVertex);
    });
  }
});
```

**Pros**: 

- Simpler implementation
- Better performance
- Maintains terra-draw compatibility

**Cons**: 

- Not truly "simultaneous" (but appears instant)
- Need to handle undo/redo for multi-patch edits

**Complexity**: Medium | **Effort**: 2-3 days

### Approach B: Custom Multi-Feature Editor

Build a custom vertex editor that replaces terra-draw for linked mode:

- Render vertices from multiple patches in a single editable layer
- Custom drag handlers that update all affected geometries
- Maintain terra-draw for independent editing

**Pros**: 

- Full control over behavior
- True simultaneous editing

**Cons**: 

- High complexity (essentially rebuilding terra-draw subset)
- Maintenance burden
- Risk of bugs in edge cases

**Complexity**: High | **Effort**: 1-2 weeks | **Not Recommended**

### Approach C: Enhanced Current Workflow (Quick Win)

Improve the AlignmentPreviewDialog UX to reduce "cumbersome" feeling:

1. **Auto-select good alignments**: In `AlignmentPreviewDialog.tsx`, automatically check neighbors with `snapQuality === 'good'`
2. **One-click align all**: Add "Align All Good Matches" button
3. **Real-time preview during editing**: Show ghosted neighbor boundaries that will update
4. **Remember alignment preferences**: Store user's typical choice (align vs gap)

**Complexity**: Low | **Effort**: 4-8 hours | **Highest ROI**

## Recommended Implementation Strategy

### Phase 1: Quick Wins (1-2 days)

Enhance the existing workflow to make it less cumbersome:

1. **Auto-selection in AlignmentPreviewDialog**:
  - Default-check all proposals with `snapQuality === 'good'`
  - Add "Select All Good" and "Select All" buttons
2. **Batch operations**:
  - "Apply All Good Alignments" button in PostEditDialog
  - Skip the AlignmentPreviewDialog if all neighbors have good snap quality
3. **Visual feedback**:
  - While editing in SimplifyPanel refine mode, show neighboring boundaries as dashed lines
  - Highlight shared segments in a different color
4. **Gap creation mode**:
  - Add "Allow gaps" toggle in SimplifyPanel
  - When enabled, automatically skip neighbor alignment step

### Phase 2: Linked Boundary Editing (Optional, 3-5 days)

If Phase 1 improvements aren't sufficient, implement Approach A:

1. **Shared vertex detection**:
  - Extend `findAdjacentPatches` to return vertex-level adjacency
  - Create `SharedBoundaryTracker` class to maintain mapping during editing
2. **Post-drag synchronization**:
  - Hook into terra-draw's change events
  - Compare before/after snapshots to detect moved vertices
  - Apply same transformation to neighboring patches
  - Update map in real-time
3. **UI controls**:
  - Toggle in SimplifyPanel: "Lock shared boundaries" (default on)
  - Visual indicator showing which vertices are locked
  - Tooltip explaining the behavior
4. **History integration**:
  - Treat multi-patch updates as single atomic operation
  - Undo/redo affects all linked patches

## Key Files to Modify

### Phase 1 (Quick Wins):

- `[AlignmentPreviewDialog.tsx](src/components/AlignmentPreviewDialog.tsx)` - Auto-selection logic
- `[PostEditDialog.tsx](src/components/PostEditDialog.tsx)` - One-click align button
- `[SimplifyPanel.tsx](src/components/SimplifyPanel.tsx)` - Gap mode toggle
- `[page.tsx](src/app/page.tsx)` - Enhanced callback handlers

### Phase 2 (Linked Editing):

- `[DrawingTools.tsx](src/components/DrawingTools.tsx)` - Change event handlers
- `[geometry-edit.ts](src/lib/geometry-edit.ts)` - New `SharedBoundaryTracker` utilities
- `[useEditHistory.ts](src/hooks/useEditHistory.ts)` - Multi-patch history support

## Risk Mitigation

1. **Performance**: For high-vertex geometries, disable linked editing (show warning)
2. **Edge cases**: Extensive testing needed for wrap-around boundaries, holes, and reversed segments
3. **User confusion**: Clear UI indicators and documentation for mode switching
4. **Data integrity**: Validate that linked updates maintain valid polygons (no self-intersections)

## Questions for Clarification

1. **Priority**: Is the current workflow's "cumbersomeness" severe enough to justify Phase 2, or would Phase 1 improvements suffice?
2. **User preference**: Do users typically want to align ALL neighbors or selectively choose? This affects auto-selection strategy.
3. **Gap scenarios**: When creating gaps intentionally, do users usually fill them immediately or leave them for later processing?
4. **Performance constraints**: What's the typical vertex count for patches being edited? (Affects feasibility of real-time updates)

## Verdict

**The feature is practical to implement**, but I recommend a **phased approach**:

- **Start with Phase 1** (1-2 days): Significant UX improvements with minimal risk
- **Evaluate user feedback**: If still cumbersome, proceed to Phase 2
- **Phase 2 if needed** (3-5 days): Implement Approach A for linked boundary editing

The current post-edit analysis system is actually quite sophisticated - it might just need better UX to feel less cumbersome rather than a complete architectural change.