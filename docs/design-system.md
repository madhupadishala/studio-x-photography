# Studio X editorial design system

## Brand tokens
Charcoal #1C1B1A, ivory #F4EFE6, champagne #D9C7A3, olive #6B6F4E, terracotta #B5623F. No gradients, glassmorphism, glowing buttons, emoji, oversized rounded cards, centered-everything layouts, or fake credentials.

## Contrast
WCAG 2.2 AA: normal text >= 4.5:1, large text and controls >= 3:1. Actual ratio assertions live in tests/unit/contrast.test.ts. Dark text on ivory, ivory on charcoal, ivory on terracotta, olive on ivory, champagne on charcoal. Terracotta on ivory is for large text or non-text accents only when >=3:1. Do not use champagne as small text on ivory.

## Typography and layout
Fraunces display; DM Sans body. Display uses fluid clamp and tight leading; body 16–18px, 1.6 line height. Twelve-column editorial grid; 1px dividers; 44px minimum controls; visible keyboard focus.

## Motion
Prefer subtle transitions and respect prefers-reduced-motion. Never make animation essential to understanding content.
