// Best-guess store section for shopping-list items, used when no category is given.
//
// Keywords are singular whole words ("_" joins multi-word ones); plurals match too
// (berry -> berries, tomato -> tomatoes). The longest matching keyword wins, so
// "peanut butter" beats "butter" and "ice cream" beats "cream".

export const SECTIONS = [
  ["Produce", "apple banana orange lemon lime grape grapefruit berry strawberry blueberry raspberry avocado tomato potato onion garlic lettuce spinach kale carrot celery cucumber pepper bell_pepper broccoli cauliflower zucchini mushroom herb cilantro parsley basil ginger fruit veg vegetable veggie salad corn peach pear plum melon watermelon cantaloupe mango pineapple cabbage squash eggplant"],
  ["Dairy & eggs", "milk cheese butter yogurt yoghurt cream sour_cream cream_cheese egg cottage_cheese mozzarella cheddar parmesan"],
  ["Meat & seafood", "chicken beef pork turkey bacon sausage ham steak mince fish salmon tuna shrimp prawn lamb"],
  ["Bakery", "bread bagel bun roll tortilla croissant muffin cake baguette pita"],
  ["Pantry", "rice pasta noodle flour sugar salt oil vinegar sauce ketchup mustard mayo cereal oat bean lentil soup stock broth spice honey jam peanut_butter coffee tea chocolate snack chip cracker nut can canned"],
  ["Frozen", "frozen ice ice_cream pizza pea fries"],
  ["Drinks", "water juice soda beer wine sparkling_water kombucha"],
  ["Household", "paper_towel toilet_paper tissue detergent soap dish_soap sponge trash_bag bag foil wrap battery batteries bulb cleaner bleach"],
  ["Personal care", "shampoo conditioner toothpaste toothbrush deodorant razor lotion sunscreen floss"],
  ["Pets", "dog_food cat_food litter pet_food kibble"],
].map(([name, words]) => [name, words.split(" ").map((w) => w.replace(/_/g, " "))]);

/** "berry" -> /\bberr(?:y|ies)\b/, "tomato" -> /\btomato(?:s|es)?\b/ */
const keywordRe = (word) => {
  const stem = word.endsWith("y") ? `${word.slice(0, -1)}(?:y|ies)` : `${word}(?:s|es)?`;
  return new RegExp(`(?:^|[^\\p{L}])${stem}(?![\\p{L}])`, "iu");
};

const KEYWORDS = SECTIONS.flatMap(([name, words]) => words.map((word) => ({ name, word, re: keywordRe(word) })))
  .sort((a, b) => b.word.length - a.word.length);

export function guessCategory(text) {
  return KEYWORDS.find((k) => k.re.test(text))?.name ?? null;
}
