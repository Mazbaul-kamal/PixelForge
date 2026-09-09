PROJECT CONTEXT — read this before every task in this project.

We are building PixelForge: a browser-based, layer-driven image editor in the spirit of Photopea. It runs entirely client-side. No backend, no image uploads to a server.

Stack and rules:
- TypeScript, Vite, ES modules. Strict mode on.
- The canvas engine is plain TypeScript. Do NOT put engine state in a UI framework. If you use a framework at all, it renders panels only and never re-renders during a brush stroke.
- No image-editing libraries. We write the compositor, the brush engine and the selection engine ourselves. Utility libraries for parsing formats (e.g. ag-psd later) are fine.
- Plain CSS with custom properties. Dark UI, neutral greys, one accent colour, so image colours are judged against a neutral surround.
- Every feature must be usable with the mouse, with a keyboard shortcut, and on a touch screen via Pointer Events.

Non-negotiable architecture:
- Document: { width, height, layers: Layer[], activeLayerId, selection }. layers[0] is the BOTTOM layer.
- Layer: { id, name, canvas, ctx, x, y, opacity, blendMode, visible, locked, type, mask? }.
- One offscreen "composite" canvas at document size. Layers are drawn into it with globalAlpha and globalCompositeOperation. The transparency checkerboard is NEVER drawn into it, only into the on-screen view, otherwise blend modes composite against the checkerboard.
- Viewport: { zoom, panX, panY } plus screenToDoc() and docToScreen() helpers. All tools work in document coordinates and convert only at the edges.
- One requestAnimationFrame loop draws the view. Nothing else touches the view canvas.
- Every user-visible change goes through the history system. A feature is not done until undo and redo restore it exactly.

Working style:
- Implement ONLY the step I give you. Leave clearly named hooks for later steps, but no placeholder features and no TODO stubs in shipped paths.
- Keep files small and single-purpose. Tell me the file tree you changed at the end.
- After each step, list what I should click to verify it works.