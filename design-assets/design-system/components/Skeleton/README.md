# Skeleton

A placeholder in the exact shape and size of content that is loading. You provide the shape.

- Shapes: text line, title line, block, circle, image frame (a Media frame in its loading state) and card.
- Fill `color-bg-skeleton`, with a 1.6 s opacity pulse (`duration-loop-pulse`). The pulse is kept under reduced motion.
- A skeleton always matches the final layout, so nothing moves when content arrives. It is hidden from assistive technology; the region announces "Loading" once.
- Use it for content with a known shape. For an action the person just took use the button spinner; for AI work use the progress bar.
