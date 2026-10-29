export const imageGroups = {
  "hero": [
    "studio-x-hindu-wedding-01-hindu-wedding-muhurtham",
    "studio-x-hindu-wedding-02-hindu-wedding-bridal-portrait",
    "studio-x-hindu-wedding-03-hindu-wedding-family"
  ],
  "gallery": [
    "studio-x-haldi-01-haldi-turmeric-ceremony",
    "studio-x-haldi-02-haldi-groom",
    "studio-x-haldi-03-haldi-friends",
    "studio-x-mehendi-01-mehendi-bridal-hands",
    "studio-x-mehendi-02-mehendi-bride",
    "studio-x-mehendi-03-mehendi-friends",
    "studio-x-engagement-01-engagement-rings",
    "studio-x-engagement-02-engagement-proposal",
    "studio-x-engagement-03-engagement-family",
    "studio-x-muslim-wedding-01-nikah-vows",
    "studio-x-muslim-wedding-02-nikah-ceremony",
    "studio-x-muslim-wedding-03-walima-reception",
    "studio-x-christian-wedding-01-christian-wedding-ceremony",
    "studio-x-christian-wedding-02-christian-bride",
    "studio-x-christian-wedding-03-christian-wedding-celebration"
  ],
  "services": [
    "studio-x-birthday-01-birthday-girl",
    "studio-x-birthday-02-birthday-cake",
    "studio-x-birthday-03-birthday-friends",
    "studio-x-maternity-01-maternity-portrait",
    "studio-x-maternity-02-maternity-couple",
    "studio-x-maternity-03-maternity-announcement"
  ],
  "about": [
    "studio-x-newborn-01-newborn-baby",
    "studio-x-newborn-02-newborn-family",
    "studio-x-newborn-03-newborn-feet",
    "studio-x-family-01-family-generations"
  ],
  "testimonials": [
    "studio-x-family-02-family-together",
    "studio-x-festival-01-diwali-celebration",
    "studio-x-festival-02-festival-home-decor"
  ]
} as const;
export type ImageGroup = keyof typeof imageGroups;
export function imageOccasion(name:string){return name.replace(/^studio-x-/,'').replace(/-\d\d-.*/,'').replace(/-/g,' ')}
export function imageAlt(name:string){return 'Illustrative '+name.replace(/^studio-x-/,'').replace(/-\d\d-/,' ').replace(/-/g,' ')+' photography scene'}
