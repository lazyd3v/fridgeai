import { useState } from 'react';

export type IconName = 'fridge' | 'recipes' | 'shopping' | 'settings' | 'expand' | 'plus' | 'close' | 'camera' | 'refresh' | 'arrow' | 'leaf' | 'send';
const paths: Record<IconName, React.ReactNode> = {
  fridge: <><rect x="5" y="2" width="14" height="20" rx="3"/><path d="M5 9h14M8 5v1M8 13v3"/></>,
  recipes: <><path d="M4 3v5a3 3 0 0 0 6 0V3M7 3v18M20 21V3c-4 2-5 8 0 9"/></>,
  shopping: <><path d="m2 3 3 1 3 12h11l3-9H6"/><circle cx="9" cy="21" r="1"/><circle cx="18" cy="21" r="1"/></>,
  settings: <><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2 1 3-3 3-3-1-2 3H8l-1-3-3-1-2-3 2-3-1-3 3-3z"/><circle cx="12" cy="11" r="3"/></>,
  expand: <path d="M14 3h7v7M21 3l-7 7M10 21H3v-7M3 21l7-7"/>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M6 18 18 6"/>,
  camera: <><path d="m8 5 2-3h4l2 3h4v16H4V5z"/><circle cx="12" cy="12" r="4"/></>,
  refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 2v6h-6"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  leaf: <><path d="M20 3C5 2 2 9 6 16s16 3 14-13ZM5 21 16 8"/></>,
  send: <path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15"/>,
};
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
const foods: [RegExp, string][] = [[/tomato/i,'tomato'],[/egg(?!plant)/i,'egg'],[/salmon/i,'salmon_fillet'],[/lemon/i,'lemon'],[/cheese/i,'cheese_wedge'],[/yog[hu]urt|yogurt/i,'yogurt'],[/cucumber/i,'cucumber'],[/basil/i,'thai_basil'],[/lettuce|greens|salad/i,'lettuce'],[/milk/i,'milk_bottle'],[/apple/i,'apple'],[/carrot/i,'carrot'],[/chicken/i,'chicken_breast'],[/broccoli/i,'broccoli'],[/spinach/i,'spinach']];
export function FoodIcon({ name, icon }: { name: string; icon?: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  // Old rows have no saved choice. Whole-word matches avoid apple/pineapple collisions.
  const legacy = foods.find(([pattern]) => new RegExp(`\\b(?:${pattern.source})s?\\b`, 'i').test(name))?.[1];
  const asset = icon == null ? legacy : icon !== 'none' && /^[a-z][a-z0-9_]*$/.test(icon) ? icon : undefined;
  return <span className="food-icon">{asset && failed !== asset ? <img src={`/private-food-icons/${asset}.png`} alt="" onError={() => setFailed(asset)} /> : <Icon name="leaf" size={28}/>}</span>;
}
export function Miso({ small = false }: { small?: boolean }) {
  return <span className={`miso ${small ? 'miso-small' : ''}`} aria-hidden="true"><span className="miso-eye"/><span className="miso-eye"/><span className="miso-smile"/></span>;
}
