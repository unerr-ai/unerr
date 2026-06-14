# Icon Documentation

This document provides a comprehensive reference for all icon variations in the project. Use this guide to select the appropriate icon for different platforms, contexts, and implementations.

## Color Palette

| Color         | Hex Code  | Usage                             |
| ------------- | --------- | --------------------------------- |
| Primary Blue  | `#1065BA` | Gradient base, borders            |
| Light Blue    | `#559EFF` | Main gradient color, glow effects |
| Bright Blue   | `#66ABFF` | Accent, strokes                   |
| Light Gray    | `#D3D3D3` | Icon fill start                   |
| White         | `#FFFFFF` | Icon fill end, highlights         |
| Black         | `#000000` | Backgrounds                       |
| Dark Blue     | `#000E1C` | Background gradient end           |
| Light Blue BG | `#E0EEFF` | Light backgrounds                 |
| Medium Blue   | `#BFDCFF` | Fill variations                   |
| Gray-Green    | `#838F77` | Gradient transitions              |

## Icon Variations

### App Icons (Primary Brand Icons)

#### 1. App Icon - Standalone

**File:** `public/icons/app.svg`  
**Dimensions:** 561×561px  
**Style:** Rounded square (180px radius)

**Colors:**

- Background: Multiple blue gradients with radial and linear effects
  - Radial gradients: `#559EFF` with opacity fades
  - Linear gradients: Various `#559EFF` transitions
  - Stroke: `#838F77` (transparent) → `#1065BA`
- X Symbol: White to light gray gradient (`#FFFFFF` → `#D3D3D3`)
- Effects: Drop shadow with blue tint

**Technical Features:**

- Multiple layered gradients for depth
- 3px stroke on X symbol
- Gaussian blur shadow (15.05px)
- 27px vertical offset on shadow
- Crisp edge rendering

**Recommended Usage:**

- **iOS App Store icon**
- **Android Play Store icon**
- **PWA (Progressive Web App) icon**
- **macOS/Windows application icon**
- **Desktop shortcuts**
- **App launcher icons**
- **High-resolution displays**
- **Premium brand presentations**

**Size Recommendations:**
| Platform | Size | Export Format |
|----------|------|---------------|
| iOS | 1024×1024px | PNG |
| Android | 512×512px | PNG |
| PWA | 512×512px | PNG |
| Favicon | 256×256px | PNG/ICO |
| macOS | 1024×1024px | PNG/ICNS |
| Windows | 256×256px | PNG/ICO |

---

#### 2. App Icon - Black Background

**File:** `public/icons/app_black_bg.svg`  
**Dimensions:** 1080×1080px  
**Style:** Centered icon on black canvas

**Colors:**

- Canvas Background: Pure black (`#000000`)
- Icon Background: Same gradient system as app.svg
- X Symbol: White to light gray gradient (`#FFFFFF` → `#D3D3D3`)
- Effects: Same drop shadow system

**Technical Features:**

- Larger canvas for social media requirements
- Perfectly centered icon
- Maintains all gradient and shadow effects
- Ideal for platforms requiring square assets

**Recommended Usage:**

- **Social media profile pictures** (Instagram, Twitter/X, LinkedIn)
- **Discord server icons**
- **Slack workspace icons**
- **YouTube channel icons**
- **Twitch profile pictures**
- **GitHub organization avatars**
- **Forum avatars**
- **Dark-themed presentations**
- **App store screenshots backgrounds**

**Size Recommendations:**
| Platform | Size | Notes |
|----------|------|-------|
| Instagram | 320×320px | Can use 1080×1080px |
| Twitter/X | 400×400px | Use full 1080×1080px |
| LinkedIn | 300×300px | Use full size |
| Discord | 512×512px | Use full size |
| YouTube | 800×800px | Use full size |

---

### Background Icons (Decorative Elements)

#### 3. Background Icon - Outline

**File:** `public/icons/background_icon.svg`  
**Dimensions:** 1060×1060px  
**Style:** Outlined X pattern with gradient fill

**Colors:**

- Fill: Linear gradient
  - Start: `#66ABFF` (Bright Blue)
  - End: `#000E1C` (Dark Blue)
- No background (transparent)
- Stroke/outline style

**Technical Features:**

- Path-based design (not solid fill)
- Vertical gradient (top to bottom)
- Geometric, angular design
- Scalable outline weight
- Transparent background for layering

**Recommended Usage:**

- **Website backgrounds** (hero sections, feature blocks)
- **Presentation slide backgrounds**
- **Marketing material backgrounds**
- **Email template backgrounds**
- **Social media post backgrounds**
- **Video thumbnails**
- **Landing page decorative elements**
- **App onboarding screens**
- **Loading screen backgrounds**
- **Print material watermarks**

**Implementation Tips:**

- Layer behind content with reduced opacity (20-40%)
- Position off-center for visual interest
- Scale to 150-200% for dramatic effect
- Use as repeating pattern for textures
- Combine multiple instances at different opacities

---

#### 4. Background Icon - Usage Example

**File:** `public/icons/background_icon_usage.svg`  
**Dimensions:** 1280×720px (16:9 aspect ratio)  
**Style:** Example implementation on canvas

**Colors:**

- Canvas Background: `#E0EEFF` (Light Blue)
- Icon Fill: `#BFDCFF` (Medium Blue)
- Icon Stroke: `#66ABFF` (Bright Blue, 4px)
- Positioned on right side of canvas

**Technical Features:**

- Demonstrates proper icon placement
- Shows size relationship to content area
- 16:9 aspect ratio for presentations
- Clipped to canvas bounds

**Recommended Usage:**

- **Reference for implementation**
- **Design system documentation**
- **Presentation slide template**
- **Wide-format social media posts** (LinkedIn, Twitter banners)
- **YouTube thumbnail template**
- **Website hero section mockup**
- **Email header template**

**Use This As:**

- Template for creating similar designs
- Guide for icon sizing and placement
- Example of color harmony
- Reference for content/background balance

---

## Platform-Specific Recommendations

### Mobile Applications

| Context                  | Recommended Icon               | Export Size | Format         |
| ------------------------ | ------------------------------ | ----------- | -------------- |
| **iOS App Icon**         | app.svg                        | 1024×1024px | PNG            |
| **Android App Icon**     | app.svg                        | 512×512px   | PNG (adaptive) |
| **iOS Spotlight**        | app.svg                        | 120×120px   | PNG            |
| **Android Notification** | app_black_bg.svg               | 192×192px   | PNG            |
| **App Loading Screen**   | app.svg or background_icon.svg | Screen size | SVG/PNG        |

### Social Media

| Platform      | Profile Picture                | Banner/Header                           |
| ------------- | ------------------------------ | --------------------------------------- |
| **Instagram** | app_black_bg.svg (1080×1080px) | background_icon_usage.svg reference     |
| **Twitter/X** | app_black_bg.svg (400×400px)   | background_icon.svg on brand colors     |
| **LinkedIn**  | app_black_bg.svg (300×300px)   | background_icon_usage.svg (1584×396px)  |
| **YouTube**   | app_black_bg.svg (800×800px)   | background_icon_usage.svg (2560×1440px) |
| **Discord**   | app_black_bg.svg (512×512px)   | background_icon.svg for banners         |
| **Twitch**    | app_black_bg.svg (256×256px)   | background_icon.svg for panels          |

### Web & Digital

| Context                | Icon Choice         | Implementation Notes               |
| ---------------------- | ------------------- | ---------------------------------- |
| **PWA Icon**           | app.svg             | 512×512px in manifest              |
| **Favicon**            | app.svg             | Multiple sizes (16, 32, 48, 64px)  |
| **Apple Touch Icon**   | app.svg             | 180×180px                          |
| **Website Background** | background_icon.svg | SVG, 20-30% opacity                |
| **Hero Section**       | background_icon.svg | Large scale, positioned off-center |
| **Loading Spinner**    | app.svg             | Animated rotation on center        |

### Marketing & Print

| Material                | Icon                         | Size Notes                  |
| ----------------------- | ---------------------------- | --------------------------- |
| **Business Cards**      | app.svg                      | Small, high quality         |
| **Brochures**           | app.svg, background_icon.svg | Both as decorative elements |
| **Posters**             | background_icon.svg          | Large format, dramatic      |
| **Trade Show Banners**  | background_icon_usage.svg    | As template reference       |
| **Presentation Slides** | background_icon_usage.svg    | 16:9 template               |
| **T-Shirts/Merch**      | app.svg                      | High contrast version       |

---

## Technical Specifications

### App Icons

- **Format:** SVG (source), export to PNG for platforms
- **Base Dimensions:** 561×561px (app.svg), 1080×1080px (app_black_bg.svg)
- **Border Radius:** 180px (creates rounded square)
- **X Symbol Stroke:** 3px
- **Shadow:** 27px offset, 15.05px blur
- **Gradients:** Multiple radial and linear for depth
- **Rendering:** Crisp edges enabled

### Background Icons

- **Format:** SVG (best for web implementation)
- **Dimensions:** 1060×1060px (icon), 1280×720px (usage example)
- **Style:** Outlined/stroked design
- **Transparency:** Yes (layerable)
- **Gradient:** Single linear gradient
- **Scalability:** Infinite (vector-based)

---

## Implementation Examples

### React / Next.js

```jsx
import Image from 'next/image';

// App icon for PWA
<Image
  src="/icons/app.svg"
  alt="1ARX App Icon"
  width={512}
  height={512}
/>

// Profile picture with black background
<div className="rounded-full overflow-hidden">
  <Image
    src="/icons/app_black_bg.svg"
    alt="1ARX"
    width={400}
    height={400}
  />
</div>

// Background decorative element
<div className="absolute inset-0 opacity-20 pointer-events-none">
  <Image
    src="/icons/background_icon.svg"
    alt=""
    fill
    className="object-cover scale-150"
  />
</div>
```

### HTML / Manifest

```html
<!-- PWA Manifest Icons -->
<link rel="icon" type="image/svg+xml" href="/icons/app.svg" />
<link rel="apple-touch-icon" sizes="180x180" href="/icons/app-180.png" />

<!-- Favicon -->
<link rel="icon" type="image/png" sizes="32x32" href="/icons/app-32.png" />
<link rel="icon" type="image/png" sizes="16x16" href="/icons/app-16.png" />
```

### PWA Manifest.json

```json
{
  "name": "1ARX",
  "icons": [
    {
      "src": "/icons/app.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    },
    {
      "src": "/icons/app-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icons/app-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/icons/app_black_bg.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "maskable"
    }
  ]
}
```

### CSS Background

```css
/* Hero section background */
.hero {
  background-color: #e0eeff;
  background-image: url("/icons/background_icon.svg");
  background-size: 150%;
  background-position: top right;
  background-repeat: no-repeat;
  opacity: 0.3;
}

/* Repeating pattern */
.pattern-bg {
  background-image: url("/icons/background_icon.svg");
  background-size: 400px 400px;
  background-repeat: repeat;
  opacity: 0.15;
}
```

### Tailwind CSS

```jsx
// Background pattern
<div className="relative">
  <div
    className="absolute inset-0 opacity-20"
    style={{
      backgroundImage: "url(/icons/background_icon.svg)",
      backgroundSize: "150%",
      backgroundPosition: "top right",
      backgroundRepeat: "no-repeat",
    }}
  />
  <div className="relative z-10">{/* Your content */}</div>
</div>
```

---

## Export Guidelines

### For App Stores

**iOS:**

```bash
# Export at required sizes
1024×1024px (App Store)
180×180px (iPhone)
167×167px (iPad Pro)
152×152px (iPad)
120×120px (iPhone notifications)
```

**Android:**

```bash
# Export in various densities
512×512px (Play Store)
xxxhdpi: 192×192px
xxhdpi: 144×144px
xhdpi: 96×96px
hdpi: 72×72px
mdpi: 48×48px
```

### For Web

**PWA Icons:**

```bash
512×512px (standard)
192×192px (Android Chrome)
180×180px (Apple Touch Icon)
```

**Favicons:**

```bash
32×32px
16×16px
96×96px (Chrome Web Store)
```

---

## Usage Guidelines

### Do's ✅

**App Icons:**

- Export at exact required dimensions for each platform
- Maintain the rounded square shape (180px radius)
- Use PNG format for final implementations
- Keep the drop shadow effect for depth
- Test on both light and dark backgrounds
- Include safe area padding for platform requirements

**Background Icons:**

- Use with reduced opacity (15-40%) for backgrounds
- Layer behind content for visual interest
- Scale up (150-200%) for dramatic effect
- Combine with brand colors
- Use as watermark at very low opacity (5-10%)

### Don'ts ❌

**App Icons:**

- Don't remove the rounded corners
- Don't change gradient colors or directions
- Don't remove the drop shadow
- Don't compress too much (maintain quality)
- Don't add external effects or modifications
- Don't use on busy backgrounds that obscure the icon

**Background Icons:**

- Don't use at 100% opacity (will overwhelm content)
- Don't distort the aspect ratio
- Don't change the gradient direction
- Don't use multiple instances at high opacity
- Don't place directly behind text (use low opacity or offset)

---

## Design System Integration

### Component Library

```tsx
// IconButton component example
interface IconButtonProps {
  variant: "app" | "app-black" | "background";
  size?: number;
  className?: string;
}

export function IconButton({ variant, size = 48, className }: IconButtonProps) {
  const iconMap = {
    app: "/icons/app.svg",
    "app-black": "/icons/app_black_bg.svg",
    background: "/icons/background_icon.svg",
  };

  return (
    <Image
      src={iconMap[variant]}
      alt="1ARX Icon"
      width={size}
      height={size}
      className={className}
    />
  );
}
```

### Storybook Stories

```tsx
// Icon showcase for design system
export const AppIcon = () => (
  <div className="flex gap-4 p-8 bg-gray-100">
    <img src="/icons/app.svg" alt="App Icon" className="w-32 h-32" />
    <img
      src="/icons/app_black_bg.svg"
      alt="App Icon Black BG"
      className="w-32 h-32"
    />
  </div>
);

export const BackgroundIcon = () => (
  <div className="relative w-full h-64 bg-blue-50">
    <div
      className="absolute inset-0 opacity-20"
      style={{
        backgroundImage: "url(/icons/background_icon.svg)",
        backgroundSize: "cover",
      }}
    />
  </div>
);
```

---

## Accessibility Notes

- **App Icons:** Include meaningful alt text when used in semantic contexts
- **Background Icons:** Use `alt=""` or `aria-hidden="true"` as they're decorative
- **Color Contrast:** All icon variations meet WCAG AA standards
- **Focus States:** Ensure proper focus indicators when icons are interactive
- **Screen Readers:** Use descriptive labels for app icons, hide decorative backgrounds

---

## Version Control & Updates

When updating icons:

1. **Document Changes:** Note any color, dimension, or effect changes
2. **Version Naming:** Use semantic versioning (v1.0, v1.1, etc.)
3. **Export Fresh Assets:** Re-export all platform-specific sizes
4. **Test Across Platforms:** Verify on iOS, Android, web browsers
5. **Update Documentation:** Keep this file current with changes

---

## Quick Reference

| Need            | Use This Icon                  | Export Size           |
| --------------- | ------------------------------ | --------------------- |
| App Store       | app.svg                        | 1024×1024px PNG       |
| Social Profile  | app_black_bg.svg               | Platform specific     |
| Website Favicon | app.svg                        | 16, 32, 48px ICO/PNG  |
| Hero Background | background_icon.svg            | SVG at 20-30% opacity |
| Presentation    | background_icon_usage.svg      | 1280×720px reference  |
| Email Signature | app.svg                        | 64×64px PNG           |
| Print Material  | app.svg or background_icon.svg | 300 DPI TIFF/PNG      |

---

## Support & Questions

For questions about icon usage, requests for additional sizes, or custom variations:

- Check the design system documentation
- Contact the design team
- Reference platform-specific guidelines (iOS HIG, Material Design, etc.)

**Last Updated:** November 2025  
**Icon Version:** 1.0  
**Design System:** 1ARX Brand Guidelines v1.0
