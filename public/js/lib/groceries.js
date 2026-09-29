// Best-guess store section for shopping-list items, used when no category is given.

export const SECTIONS = [
  ["Produce", "apple banana orange lemon lime grape berries strawberr blueberr raspberr avocado tomato potato onion garlic lettuce spinach kale carrot celery cucumber pepper broccoli cauliflower zucchini mushroom herbs cilantro parsley basil ginger fruit veg salad corn peach pear plum melon mango pineapple cabbage squash"],
  ["Dairy & eggs", "milk cheese butter yogurt yoghurt cream egg eggs sour cream cottage mozzarella cheddar parmesan"],
  ["Meat & seafood", "chicken beef pork turkey bacon sausage ham steak mince ground fish salmon tuna shrimp prawn lamb"],
  ["Bakery", "bread bagel bun buns rolls tortilla croissant muffin cake baguette pita"],
  ["Pantry", "rice pasta noodle flour sugar salt oil vinegar sauce ketchup mustard mayo cereal oats beans lentils soup stock broth spice honey jam peanut butter coffee tea chocolate snack chips crackers nuts can canned"],
  ["Frozen", "frozen ice cream pizza peas fries"],
  ["Drinks", "water juice soda beer wine sparkling kombucha"],
  ["Household", "paper towel toilet paper tissue detergent soap dish sponge trash bag bags foil wrap battery batteries bulb cleaner bleach"],
  ["Personal care", "shampoo conditioner toothpaste toothbrush deodorant razor lotion sunscreen floss"],
  ["Pets", "dog cat litter pet kibble"],
].map(([name, words]) => [name, words.split(" ")]);

export function guessCategory(text) {
  const t = ` ${text.toLowerCase()} `;
  for (const [name, words] of SECTIONS) {
    if (words.some((w) => t.includes(` ${w}`))) return name;
  }
  return null;
}
