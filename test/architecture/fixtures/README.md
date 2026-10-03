# Boundary fixtures

`src/architecture/boundaries.spec.ts` runs the real rules of `.dependency-cruiser.cjs` over this tree.
Each file marked "Breaks" breaks exactly one rule, once. Every other import here is allowed and must
stay unflagged. The tree is never part of the application: the boundary check cruises `src/` only, and
the build leaves `test/` out.
