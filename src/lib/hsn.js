// HSN codes — validation and search.
//
// TWO LEVELS OF CHECKING
//   1. Shape   - 4, 6 or 8 digits, and enough digits for the firm's turnover.
//                Costs nothing, works offline, catches most mistakes.
//   2. Real    - does the code actually exist? Needs the HSN master below.
//
// ABOUT THE LIST BELOW
// These are 4-DIGIT HEADINGS, chosen for the trades that actually use Skwik:
// kirana and general stores, chemists, hardware and building material,
// garments and footwear, stationery, electrical goods, and the services a
// shop bills alongside its goods. Four digits is what the portal requires
// below 5 crore of turnover, which is every shop this app is sold to.
//
// It is NOT the full master. The official one runs to roughly 20,000 entries
// once 6 and 8 digit codes are counted. A shop above 5 crore, or one whose
// goods are not here, should load the real thing with setHsnMaster() — the
// search, the validation and the item screen all read whatever is loaded, and
// nothing else in the app changes.
//
// Duplicated headings are harmless: hsnExists and hsnDesc take the first
// match, and searchHsn scores them the same.
//
// GST RATES ARE DELIBERATELY NOT IN THIS LIST. Rates change, and a wrong rate
// is a tax problem, not a typo. The shopkeeper types the rate he charges.
// If your replacement master carries a verified rate, put it in `gst_rate`
// and the item screen will fill it in automatically.

let MASTER = [
  // Iron, steel and metal goods
  { hsn: '7213', desc: 'Bars and rods of iron or non-alloy steel, hot-rolled', w: 'sariya rod tmt bar iron rod' },
  { hsn: '7214', desc: 'Other bars and rods of iron or non-alloy steel', w: 'iron bar rod flat angle' },
  { hsn: '7308', desc: 'Structures and parts of structures, of iron or steel', w: 'grill gate shutter angle channel structure truss' },
  { hsn: '7310', desc: 'Tanks, casks, drums, cans and boxes of iron or steel, up to 300 litres', w: 'steel drum tin can barrel container box' },
  { hsn: '7317', desc: 'Nails, tacks, staples and similar articles of iron or steel', w: 'nail kanti tack screw staple' },
  { hsn: '7321', desc: 'Stoves, ranges, cookers and similar appliances of iron or steel', w: 'stove chulha gas cooker angithi' },
  { hsn: '7323', desc: 'Table, kitchen and household articles of iron or steel', w: 'thali plate batti balty bucket bartan tiffin steel utensil kadai tawa dabba casserole' },
  { hsn: '7326', desc: 'Other articles of iron or steel', w: 'steel article clamp bracket hook chain' },
  { hsn: '7418', desc: 'Table, kitchen and household articles of copper' },
  { hsn: '7612', desc: 'Aluminium casks, drums, cans and boxes, up to 300 litres', w: 'aluminium drum can barrel' },
  { hsn: '7607', desc: 'Aluminium foil' },
  { hsn: '7615', desc: 'Table, kitchen and household articles of aluminium', w: 'aluminium balty bucket patila tope utensil handi foil box' },
  { hsn: '8211', desc: 'Knives with cutting blades', w: 'knife chaku blade' },
  { hsn: '8212', desc: 'Razors and razor blades' },
  { hsn: '8215', desc: 'Spoons, forks, ladles and similar kitchen or tableware', w: 'spoon chamach fork ladle karchi serving' },
  { hsn: '8301', desc: 'Padlocks and locks of base metal', w: 'lock tala padlock latch' },
  { hsn: '8302', desc: 'Mountings, fittings and similar articles of base metal', w: 'hinge handle fitting bracket runner' },
  { hsn: '8481', desc: 'Taps, cocks, valves and similar appliances', w: 'tap nal valve cock bib faucet' },
  { hsn: '9617', desc: 'Vacuum flasks and other vacuum vessels', w: 'flask thermos casserole hot pot' },

  // Plastics and rubber
  { hsn: '3917', desc: 'Tubes, pipes and hoses of plastics', w: 'pvc pipe hose tube gi pipe plumbing conduit' },
  { hsn: '3919', desc: 'Self-adhesive plates, sheets and film of plastics' },
  { hsn: '3920', desc: 'Other plates, sheets and film of plastics, non-cellular' },
  { hsn: '3921', desc: 'Other plates, sheets and film of plastics' },
  { hsn: '3922', desc: 'Baths, sinks, washbasins and sanitary ware of plastics' },
  { hsn: '3923', desc: 'Articles for conveyance or packing of goods, of plastics', w: 'plastic drum jar carboy crate container can bottle packing bag' },
  { hsn: '3924', desc: 'Tableware, kitchenware and household articles of plastics', w: 'plastic bucket mug jug tub bin basket chair stool bowl casserole water bottle dustbin' },
  { hsn: '3925', desc: 'Builders ware of plastics, including water tanks', w: 'water tank sintex tank door window pvc fitting' },
  { hsn: '3926', desc: 'Other articles of plastics', w: 'plastic article sheet hanger clip pipe fitting misc' },
  { hsn: '4011', desc: 'New pneumatic tyres of rubber', w: 'tyre tube' },

  // Glass, ceramic, stone, cement
  { hsn: '2523', desc: 'Cement, including clinker', w: 'cement bag opc ppc' },
  { hsn: '6810', desc: 'Articles of cement, concrete or artificial stone', w: 'cement block tile pole slab' },
  { hsn: '6911', desc: 'Tableware and kitchenware of porcelain or china', w: 'crockery cup plate bone china porcelain' },
  { hsn: '6912', desc: 'Ceramic tableware and kitchenware, other than porcelain', w: 'ceramic cup plate mug pottery' },
  { hsn: '6914', desc: 'Other ceramic articles' },
  { hsn: '7005', desc: 'Float glass and surface ground glass, in sheets' },
  { hsn: '7007', desc: 'Safety glass' },
  { hsn: '7009', desc: 'Glass mirrors' },
  { hsn: '7013', desc: 'Glassware for table, kitchen, toilet or office', w: 'glass tumbler bowl jar glassware' },

  // Wood, paper, printed
  { hsn: '4410', desc: 'Particle board and similar board of wood', w: 'particle board mdf' },
  { hsn: '4411', desc: 'Fibreboard of wood' },
  { hsn: '4412', desc: 'Plywood, veneered panels and similar laminated wood', w: 'plywood ply board commercial' },
  { hsn: '4802', desc: 'Uncoated paper and paperboard for writing or printing' },
  { hsn: '4818', desc: 'Toilet paper, tissues, towels and similar household paper', w: 'tissue toilet paper napkin' },
  { hsn: '4819', desc: 'Cartons, boxes, cases and bags of paper or paperboard', w: 'carton box peti packing paper' },
  { hsn: '4820', desc: 'Registers, note books, letter pads and similar articles', w: 'copy notebook register khata diary' },
  { hsn: '4901', desc: 'Printed books, brochures and similar printed matter' },
  { hsn: '9608', desc: 'Ball point pens, felt tipped pens and pencils', w: 'pen ball pen refill' },
  { hsn: '9609', desc: 'Pencils, crayons, pastels and chalks' },

  // Food and grocery
  { hsn: '0901', desc: 'Coffee' },
  { hsn: '0902', desc: 'Tea', w: 'tea chai patti' },
  { hsn: '1006', desc: 'Rice', w: 'rice chawal' },
  { hsn: '1101', desc: 'Wheat or meslin flour', w: 'atta maida flour wheat' },
  { hsn: '1102', desc: 'Cereal flours other than wheat' },
  { hsn: '1507', desc: 'Soya-bean oil and its fractions' },
  { hsn: '1511', desc: 'Palm oil and its fractions', w: 'palm oil cooking oil' },
  { hsn: '1512', desc: 'Sunflower, safflower or cotton-seed oil', w: 'sunflower oil cooking' },
  { hsn: '1517', desc: 'Margarine, edible mixtures of fats and oils', w: 'vanaspati dalda margarine' },
  { hsn: '1701', desc: 'Cane or beet sugar', w: 'sugar chini' },
  { hsn: '1704', desc: 'Sugar confectionery, not containing cocoa' },
  { hsn: '1806', desc: 'Chocolate and other food preparations containing cocoa' },
  { hsn: '1905', desc: 'Bread, pastry, cakes, biscuits and other bakers wares', w: 'biscuit bread namkeen bakery' },
  { hsn: '2106', desc: 'Food preparations not elsewhere specified' },
  { hsn: '2201', desc: 'Waters, including mineral and aerated, no added sugar', w: 'water bottle mineral packaged' },
  { hsn: '2202', desc: 'Waters with added sugar and other non-alcoholic beverages', w: 'cold drink soft drink juice beverage' },
  { hsn: '0904', desc: 'Pepper, chillies and other spices of the genus Capsicum' },
  { hsn: '0910', desc: 'Ginger, saffron, turmeric and other spices' },

  // Cleaning, personal care, medical
  { hsn: '3004', desc: 'Medicaments, in measured doses or retail packing' },
  { hsn: '3305', desc: 'Preparations for use on the hair', w: 'shampoo hair oil' },
  { hsn: '3306', desc: 'Preparations for oral or dental hygiene', w: 'toothpaste manjan brush' },
  { hsn: '3307', desc: 'Shaving preparations, deodorants and bath preparations' },
  { hsn: '3401', desc: 'Soap and organic surface-active products', w: 'soap sabun bathing' },
  { hsn: '3402', desc: 'Washing and cleaning preparations, detergents', w: 'detergent surf washing powder cleaner phenyl' },
  { hsn: '3506', desc: 'Prepared glues and adhesives', w: 'fevicol adhesive gum glue' },
  { hsn: '9603', desc: 'Brooms, brushes, mops and feather dusters', w: 'broom jhadu brush mop' },
  { hsn: '9619', desc: 'Sanitary towels, napkins and similar articles', w: 'diaper sanitary napkin pad' },

  // Textiles, clothing, footwear
  { hsn: '5208', desc: 'Woven fabrics of cotton, 85% or more cotton', w: 'cotton cloth fabric' },
  { hsn: '6109', desc: 'T-shirts, singlets and other vests, knitted' },
  { hsn: '6203', desc: 'Mens suits, jackets, trousers and shorts' },
  { hsn: '6204', desc: 'Womens suits, jackets, dresses, skirts and trousers' },
  { hsn: '6302', desc: 'Bed linen, table linen, toilet and kitchen linen', w: 'bedsheet chadar towel linen' },
  { hsn: '6303', desc: 'Curtains, blinds and bed valances' },
  { hsn: '6304', desc: 'Other furnishing articles' },
  { hsn: '6305', desc: 'Sacks and bags, for packing of goods', w: 'bora sack bag pp gunny' },
  { hsn: '6402', desc: 'Footwear with outer soles and uppers of rubber or plastics', w: 'chappal slipper shoe footwear plastic' },
  { hsn: '6403', desc: 'Footwear with uppers of leather', w: 'shoe leather footwear' },
  { hsn: '6404', desc: 'Footwear with uppers of textile materials' },
  { hsn: '4202', desc: 'Trunks, suitcases, handbags and similar containers', w: 'bag suitcase trunk purse school bag' },
  { hsn: '6601', desc: 'Umbrellas and sun umbrellas' },

  // Electrical, machines, vehicles
  { hsn: '8413', desc: 'Pumps for liquids', w: 'pump motor submersible' },
  { hsn: '8414', desc: 'Air or vacuum pumps, fans and ventilating hoods', w: 'fan exhaust cooler blower' },
  { hsn: '8415', desc: 'Air conditioning machines' },
  { hsn: '8418', desc: 'Refrigerators, freezers and other cooling equipment' },
  { hsn: '8450', desc: 'Household or laundry-type washing machines' },
  { hsn: '8506', desc: 'Primary cells and primary batteries', w: 'battery cell pencil cell' },
  { hsn: '8507', desc: 'Electric accumulators, including storage batteries', w: 'battery inverter lead acid' },
  { hsn: '8516', desc: 'Electric heaters, irons and other domestic appliances', w: 'iron press heater geyser kettle rod' },
  { hsn: '8517', desc: 'Telephone sets and other apparatus for communication' },
  { hsn: '8528', desc: 'Monitors and projectors, television receivers' },
  { hsn: '8544', desc: 'Insulated wire, cable and other insulated conductors', w: 'wire cable electric copper' },
  { hsn: '9405', desc: 'Lamps and lighting fittings', w: 'bulb light led lamp tube fitting' },
  { hsn: '8708', desc: 'Parts and accessories of motor vehicles', w: 'spare part motor vehicle' },
  { hsn: '8711', desc: 'Motorcycles and cycles with an auxiliary motor' },
  { hsn: '8714', desc: 'Parts and accessories of motorcycles and bicycles', w: 'cycle part bicycle spare' },
  { hsn: '2710', desc: 'Petroleum oils, other than crude' },

  // Furniture, household, other
  { hsn: '9401', desc: 'Seats, whether or not convertible into beds', w: 'chair sofa seat stool' },
  { hsn: '9403', desc: 'Other furniture and parts thereof', w: 'furniture almirah table rack cupboard' },
  { hsn: '9404', desc: 'Mattress supports, mattresses, quilts and pillows', w: 'mattress pillow quilt razai gadda' },
  { hsn: '3208', desc: 'Paints and varnishes in a non-aqueous medium', w: 'paint enamel varnish oil paint' },
  { hsn: '3209', desc: 'Paints and varnishes in an aqueous medium', w: 'paint emulsion distemper water paint' },
  { hsn: '3210', desc: 'Other paints, varnishes and prepared water pigments', w: 'paint primer putty' },
  { hsn: '7117', desc: 'Imitation jewellery', w: 'imitation jewellery bangle chudi artificial' },
  { hsn: '7113', desc: 'Articles of jewellery of precious metal' },
  { hsn: '9101', desc: 'Wrist watches with case of precious metal' },
  { hsn: '9102', desc: 'Other wrist watches and pocket watches' },
  { hsn: '9503', desc: 'Tricycles, dolls and other toys', w: 'toy khilona' },
  { hsn: '9506', desc: 'Articles for general physical exercise and sports' },

  /* ---------------- KIRANA: grains, pulses, flour ---------------- */
  { hsn: '0713', desc: 'Dried leguminous vegetables, shelled (pulses)', w: 'dal pulses moong masoor arhar chana rajma urad toor' },
  { hsn: '1001', desc: 'Wheat and meslin', w: 'gehu wheat' },
  { hsn: '1006', desc: 'Rice', w: 'chawal rice basmati' },
  { hsn: '1005', desc: 'Maize (corn)', w: 'makka maize corn' },
  { hsn: '1007', desc: 'Grain sorghum', w: 'jowar sorghum' },
  { hsn: '1008', desc: 'Buckwheat, millet and canary seed', w: 'bajra ragi millet' },
  { hsn: '1101', desc: 'Wheat or meslin flour', w: 'atta maida flour' },
  { hsn: '1102', desc: 'Cereal flours other than of wheat', w: 'flour besan makki atta' },
  { hsn: '1103', desc: 'Cereal groats, meal and pellets', w: 'suji rava semolina daliya' },
  { hsn: '1106', desc: 'Flour and meal of dried leguminous vegetables', w: 'besan gram flour' },
  { hsn: '0714', desc: 'Manioc, arrowroot, sweet potatoes and similar roots', w: 'sabudana tapioca arrowroot' },

  /* ---------------- KIRANA: oils, sugar, salt, spices ---------------- */
  { hsn: '1507', desc: 'Soya-bean oil and its fractions', w: 'soyabean oil soya tel' },
  { hsn: '1508', desc: 'Ground-nut oil and its fractions', w: 'groundnut oil mungfali tel' },
  { hsn: '1511', desc: 'Palm oil and its fractions', w: 'palm oil palmolein' },
  { hsn: '1512', desc: 'Sunflower, safflower or cotton-seed oil', w: 'sunflower oil surajmukhi' },
  { hsn: '1514', desc: 'Rape, colza or mustard oil', w: 'mustard oil sarson tel kachi ghani' },
  { hsn: '1513', desc: 'Coconut, palm kernel or babassu oil', w: 'coconut oil nariyal tel' },
  { hsn: '1517', desc: 'Margarine and edible mixtures of fats or oils', w: 'vanaspati dalda margarine' },
  { hsn: '0401', desc: 'Milk and cream, not concentrated', w: 'milk doodh fresh milk' },
  { hsn: '0402', desc: 'Milk and cream, concentrated or sweetened', w: 'milk powder condensed milk' },
  { hsn: '0403', desc: 'Yoghurt, buttermilk, curdled milk and cream', w: 'dahi curd lassi chaas yoghurt' },
  { hsn: '0405', desc: 'Butter and other fats derived from milk; dairy spreads', w: 'butter makhan ghee' },
  { hsn: '0406', desc: 'Cheese and curd', w: 'paneer cheese chena' },
  { hsn: '0407', desc: 'Birds eggs, in shell', w: 'egg anda' },
  { hsn: '1701', desc: 'Cane or beet sugar and chemically pure sucrose', w: 'sugar cheeni shakkar' },
  { hsn: '1702', desc: 'Other sugars; sugar syrups; artificial honey', w: 'gur jaggery glucose syrup' },
  { hsn: '0409', desc: 'Natural honey', w: 'honey shahad' },
  { hsn: '2501', desc: 'Salt and pure sodium chloride', w: 'salt namak' },
  { hsn: '0904', desc: 'Pepper; dried or crushed fruits of the genus Capsicum', w: 'kali mirch pepper mirchi chilli powder' },
  { hsn: '0906', desc: 'Cinnamon and cinnamon-tree flowers', w: 'dalchini cinnamon' },
  { hsn: '0907', desc: 'Cloves', w: 'laung clove' },
  { hsn: '0908', desc: 'Nutmeg, mace and cardamoms', w: 'elaichi cardamom jaiphal javitri' },
  { hsn: '0909', desc: 'Seeds of anise, coriander, cumin, fennel', w: 'jeera dhania saunf ajwain cumin coriander' },
  { hsn: '0910', desc: 'Ginger, saffron, turmeric, bay leaves, curry and other spices', w: 'haldi turmeric adrak ginger kesar masala garam masala' },
  { hsn: '0902', desc: 'Tea', w: 'tea chai patti' },
  { hsn: '0901', desc: 'Coffee, whether or not roasted', w: 'coffee' },
  { hsn: '2103', desc: 'Sauces, mixed condiments and mustard', w: 'sauce ketchup soya sauce vinegar chutney' },
  { hsn: '2001', desc: 'Vegetables and fruit prepared by vinegar or acetic acid', w: 'pickle achar' },
  { hsn: '2007', desc: 'Jams, fruit jellies, marmalades and purees', w: 'jam jelly murabba' },
  { hsn: '2009', desc: 'Fruit and vegetable juices', w: 'juice fruit juice' },
  { hsn: '0713', desc: 'Dried leguminous vegetables, shelled', w: 'dal pulses' },
  { hsn: '0802', desc: 'Other nuts, fresh or dried', w: 'badam almond kaju cashew akhrot walnut pista' },
  { hsn: '0806', desc: 'Grapes, fresh or dried', w: 'kishmish raisin grapes' },
  { hsn: '0813', desc: 'Dried fruit other than that of headings 0801 to 0806', w: 'dry fruit khajoor anjeer dates' },
  { hsn: '0701', desc: 'Potatoes, fresh or chilled', w: 'aloo potato' },
  { hsn: '0703', desc: 'Onions, shallots, garlic and leeks, fresh or chilled', w: 'pyaz onion lehsun garlic' },
  { hsn: '0702', desc: 'Tomatoes, fresh or chilled', w: 'tamatar tomato' },
  { hsn: '0709', desc: 'Other vegetables, fresh or chilled', w: 'sabzi vegetable fresh' },

  /* ---------------- KIRANA: packaged foods, snacks, drinks ---------------- */
  { hsn: '1902', desc: 'Pasta, macaroni, noodles and couscous', w: 'noodles maggi pasta macaroni vermicelli sewai' },
  { hsn: '1904', desc: 'Prepared foods obtained by swelling or roasting cereals', w: 'cornflakes poha muri cereal oats' },
  { hsn: '1905', desc: 'Bread, pastry, cakes, biscuits and other bakers wares', w: 'bread biscuit cake rusk pav roti khari toast' },
  { hsn: '2106', desc: 'Food preparations not elsewhere specified', w: 'namkeen mixture supari soft drink concentrate protein' },
  { hsn: '2105', desc: 'Ice cream and other edible ice', w: 'ice cream kulfi' },
  { hsn: '1806', desc: 'Chocolate and other food preparations containing cocoa', w: 'chocolate cocoa' },
  { hsn: '1704', desc: 'Sugar confectionery not containing cocoa', w: 'toffee candy lollipop mithai sweets' },
  { hsn: '2202', desc: 'Waters with added sugar; other non-alcoholic beverages', w: 'cold drink soft drink pepsi coke juice packed water' },
  { hsn: '2201', desc: 'Waters, including natural mineral waters and aerated waters', w: 'mineral water bisleri packaged water' },
  { hsn: '2101', desc: 'Extracts and concentrates of coffee, tea or mate', w: 'instant coffee tea premix bru nescafe' },

  /* ---------------- TOBACCO AND PAN ---------------- */
  { hsn: '2402', desc: 'Cigars, cheroots and cigarettes of tobacco', w: 'cigarette bidi cigar' },
  { hsn: '2403', desc: 'Other manufactured tobacco; chewing tobacco', w: 'zarda khaini gutkha hookah tobacco' },
  { hsn: '2106', desc: 'Pan masala and other food preparations', w: 'pan masala' },
  { hsn: '1404', desc: 'Vegetable products not elsewhere specified', w: 'betel leaf pan supari' },

  /* ---------------- OUTSIDE GST ALTOGETHER ---------------- */
  // These are outside GST by the Constitution, not by a notification that can
  // change next quarter, so the kind is safe to set here.
  { hsn: '2710', desc: 'Petroleum oils other than crude (petrol, diesel, kerosene)', w: 'petrol diesel kerosene mobil oil', supply: 'non_gst' },
  { hsn: '2711', desc: 'Petroleum gases and other gaseous hydrocarbons', w: 'lpg gas cylinder cng' },
  { hsn: '2203', desc: 'Beer made from malt', w: 'beer', supply: 'non_gst' },
  { hsn: '2208', desc: 'Undenatured ethyl alcohol; spirits, liqueurs', w: 'liquor whisky rum daru sharab', supply: 'non_gst' },
  { hsn: '2716', desc: 'Electrical energy', w: 'electricity bijli', supply: 'non_gst' },

  /* ---------------- CHEMIST ---------------- */
  { hsn: '3003', desc: 'Medicaments, not in measured doses or for retail sale', w: 'medicine bulk drug' },
  { hsn: '3004', desc: 'Medicaments in measured doses or put up for retail sale', w: 'medicine dawa tablet capsule syrup injection ointment' },
  { hsn: '3005', desc: 'Wadding, gauze, bandages and similar articles', w: 'bandage cotton gauze dressing band aid' },
  { hsn: '3006', desc: 'Pharmaceutical goods specified in Note 4 to this Chapter', w: 'surgical suture dental first aid' },
  { hsn: '3002', desc: 'Human blood; vaccines; toxins; cultures', w: 'vaccine serum' },
  { hsn: '9018', desc: 'Instruments and appliances used in medical or surgical sciences', w: 'syringe thermometer bp machine stethoscope glucometer nebuliser' },
  { hsn: '9021', desc: 'Orthopaedic appliances; artificial parts of the body', w: 'crutch walker hearing aid belt support' },
  { hsn: '4015', desc: 'Articles of apparel and accessories of vulcanised rubber', w: 'gloves surgical gloves condom' },
  { hsn: '9619', desc: 'Sanitary towels, napkins, tampons and diapers', w: 'sanitary pad napkin diaper' },

  /* ---------------- COSMETICS, SOAP, HOUSEHOLD CHEMICALS ---------------- */
  { hsn: '3401', desc: 'Soap; organic surface-active products in bars or cakes', w: 'soap sabun bathing soap detergent cake' },
  { hsn: '3402', desc: 'Organic surface-active agents; washing and cleaning preparations', w: 'detergent surf powder liquid dishwash' },
  { hsn: '3305', desc: 'Preparations for use on the hair', w: 'shampoo hair oil hair dye conditioner' },
  { hsn: '3306', desc: 'Preparations for oral or dental hygiene', w: 'toothpaste manjan toothbrush mouthwash' },
  { hsn: '3307', desc: 'Pre-shave, shaving or after-shave preparations, deodorants', w: 'shaving cream deodorant talc perfume agarbatti' },
  { hsn: '3304', desc: 'Beauty or make-up preparations and skin care', w: 'cream lotion powder lipstick nail polish sindoor bindi' },
  { hsn: '3303', desc: 'Perfumes and toilet waters', w: 'perfume itra scent' },
  { hsn: '3406', desc: 'Candles, tapers and the like', w: 'candle mombatti' },
  { hsn: '3407', desc: 'Modelling pastes; dental waxes', w: 'clay modelling' },
  { hsn: '3808', desc: 'Insecticides, rodenticides, fungicides, herbicides', w: 'mosquito coil hit all out phenyl insecticide pesticide' },
  { hsn: '3814', desc: 'Organic composite solvents and thinners', w: 'thinner turpentine solvent' },
  { hsn: '2710', desc: 'Lubricating oils and greases', w: 'grease lubricant engine oil' },

  /* ---------------- STATIONERY, PAPER, PRINT ---------------- */
  { hsn: '4802', desc: 'Uncoated paper and paperboard for writing or printing', w: 'paper a4 sheet ream' },
  { hsn: '4817', desc: 'Envelopes, letter cards and correspondence cards', w: 'envelope lifafa' },
  { hsn: '4818', desc: 'Toilet paper, tissues, napkins, towels of paper', w: 'tissue toilet paper napkin' },
  { hsn: '4819', desc: 'Cartons, boxes, cases and bags of paper or paperboard', w: 'carton box packing box paper bag' },
  { hsn: '4820', desc: 'Registers, account books, note books, diaries, files', w: 'register notebook copy diary file bill book' },
  { hsn: '4821', desc: 'Paper or paperboard labels of all kinds', w: 'label sticker tag' },
  { hsn: '4901', desc: 'Printed books, brochures and similar printed matter', w: 'book kitab textbook' },
  { hsn: '4902', desc: 'Newspapers, journals and periodicals', w: 'newspaper akhbar magazine' },
  { hsn: '4911', desc: 'Other printed matter, including printed pictures', w: 'calendar poster pamphlet card printed' },
  { hsn: '9608', desc: 'Ball point pens, felt tipped pens, propelling pencils', w: 'pen ballpen gel pen marker sketch pen' },
  { hsn: '9609', desc: 'Pencils, crayons, pastels, chalks', w: 'pencil crayon chalk eraser rubber' },
  { hsn: '9610', desc: 'Slates and boards with writing or drawing surfaces', w: 'slate white board black board' },
  { hsn: '9017', desc: 'Drawing, marking-out or mathematical calculating instruments', w: 'geometry box scale compass divider' },
  { hsn: '3506', desc: 'Prepared glues and other prepared adhesives', w: 'glue fevicol gum adhesive fevikwik' },
  { hsn: '3919', desc: 'Self-adhesive plates, sheets and film of plastics', w: 'cello tape tape adhesive tape' },

  /* ---------------- GARMENTS, TEXTILES, FOOTWEAR ---------------- */
  { hsn: '6101', desc: 'Mens or boys overcoats, anoraks, knitted or crocheted', w: 'jacket sweater mens knitted' },
  { hsn: '6103', desc: 'Mens or boys suits, trousers, knitted or crocheted', w: 'track pant lower mens knitted' },
  { hsn: '6104', desc: 'Womens or girls suits, dresses, skirts, knitted or crocheted', w: 'ladies dress kurti knitted' },
  { hsn: '6105', desc: 'Mens or boys shirts, knitted or crocheted', w: 't shirt tshirt mens shirt knitted' },
  { hsn: '6106', desc: 'Womens or girls blouses and shirts, knitted or crocheted', w: 'ladies top blouse knitted' },
  { hsn: '6107', desc: 'Mens or boys underpants, nightshirts, dressing gowns', w: 'underwear baniyan vest mens inner' },
  { hsn: '6108', desc: 'Womens or girls slips, briefs, nightdresses', w: 'ladies inner nighty petticoat' },
  { hsn: '6109', desc: 'T-shirts, singlets and other vests, knitted or crocheted', w: 't shirt vest baniyan' },
  { hsn: '6110', desc: 'Jerseys, pullovers, cardigans, knitted or crocheted', w: 'sweater pullover cardigan jersey' },
  { hsn: '6203', desc: 'Mens or boys suits, jackets, trousers, not knitted', w: 'pant trouser mens suit blazer formal' },
  { hsn: '6204', desc: 'Womens or girls suits, dresses, skirts, not knitted', w: 'salwar suit dress ladies skirt' },
  { hsn: '6205', desc: 'Mens or boys shirts, not knitted', w: 'shirt kameez mens shirt' },
  { hsn: '6206', desc: 'Womens or girls blouses and shirts, not knitted', w: 'ladies shirt blouse top' },
  { hsn: '6211', desc: 'Track suits, ski suits and swimwear; other garments', w: 'track suit kurta dhoti ladies suit' },
  { hsn: '6212', desc: 'Brassieres, girdles, corsets and braces', w: 'bra lingerie inner' },
  { hsn: '6214', desc: 'Shawls, scarves, mufflers, mantillas and veils', w: 'dupatta shawl stole scarf chunni muffler gamosa' },
  { hsn: '6217', desc: 'Other made up clothing accessories', w: 'tie belt cloth accessory' },
  { hsn: '5208', desc: 'Woven fabrics of cotton, 85% or more cotton', w: 'cotton cloth fabric kapda' },
  { hsn: '5407', desc: 'Woven fabrics of synthetic filament yarn', w: 'synthetic cloth polyester fabric' },
  { hsn: '5007', desc: 'Woven fabrics of silk or silk waste', w: 'silk saree pat muga' },
  { hsn: '5806', desc: 'Narrow woven fabrics; narrow fabrics of warp and weft', w: 'lace border ribbon' },
  { hsn: '6302', desc: 'Bed linen, table linen, toilet linen and kitchen linen', w: 'bedsheet towel chadar pillow cover napkin' },
  { hsn: '6301', desc: 'Blankets and travelling rugs', w: 'blanket kambal' },
  { hsn: '5701', desc: 'Carpets and other textile floor coverings, knotted', w: 'carpet durrie rug' },
  { hsn: '6305', desc: 'Sacks and bags of a kind used for packing goods', w: 'bora sack gunny bag packing bag' },
  { hsn: '6403', desc: 'Footwear with uppers of leather', w: 'shoe leather shoe sandal' },
  { hsn: '6402', desc: 'Other footwear with outer soles and uppers of rubber or plastics', w: 'chappal slipper hawai sandal rubber shoe' },
  { hsn: '6404', desc: 'Footwear with uppers of textile materials', w: 'canvas shoe sports shoe keds' },
  { hsn: '6405', desc: 'Other footwear', w: 'footwear chappal' },
  { hsn: '5402', desc: 'Synthetic filament yarn', w: 'yarn dhaga thread' },
  { hsn: '5508', desc: 'Sewing thread of man-made staple fibres', w: 'sewing thread dhaga' },
  { hsn: '9606', desc: 'Buttons, press-fasteners, snap-fasteners and zip fasteners', w: 'button zip hook chain' },

  /* ---------------- HARDWARE, BUILDING, ELECTRICAL ---------------- */
  { hsn: '2523', desc: 'Portland cement, aluminous cement and similar hydraulic cements', w: 'cement' },
  { hsn: '6810', desc: 'Articles of cement, concrete or artificial stone', w: 'concrete block cement pipe' },
  { hsn: '6907', desc: 'Ceramic flags and paving, hearth or wall tiles', w: 'tile ceramic tile floor tile' },
  { hsn: '6910', desc: 'Ceramic sinks, wash basins, water closet pans and similar', w: 'basin commode sink toilet sanitary' },
  { hsn: '3922', desc: 'Baths, shower-baths, sinks, lavatory seats of plastics', w: 'plastic tank seat cover pvc sanitary' },
  { hsn: '3917', desc: 'Tubes, pipes and hoses of plastics', w: 'pvc pipe hose plastic pipe' },
  { hsn: '3925', desc: 'Builders ware of plastics', w: 'pvc door window plastic fitting tank' },
  { hsn: '7304', desc: 'Tubes, pipes and hollow profiles, seamless, of iron or steel', w: 'gi pipe steel pipe' },
  { hsn: '7306', desc: 'Other tubes, pipes and hollow profiles of iron or steel', w: 'pipe square pipe gi pipe' },
  { hsn: '7210', desc: 'Flat-rolled products of iron or steel, plated or coated', w: 'gp sheet cr sheet colour coated' },
  { hsn: '7208', desc: 'Flat-rolled products of iron or non-alloy steel, hot-rolled', w: 'hr sheet plate steel sheet' },
  { hsn: '7216', desc: 'Angles, shapes and sections of iron or non-alloy steel', w: 'angle channel beam patti' },
  { hsn: '7314', desc: 'Cloth, grill, netting and fencing of iron or steel wire', w: 'jali mesh net fencing' },
  { hsn: '7312', desc: 'Stranded wire, ropes, cables of iron or steel', w: 'wire rope steel rope' },
  { hsn: '7318', desc: 'Screws, bolts, nuts, washers of iron or steel', w: 'screw bolt nut washer rivet' },
  { hsn: '8205', desc: 'Hand tools not elsewhere specified', w: 'hammer plier spanner screwdriver chisel hand tool' },
  { hsn: '8201', desc: 'Hand tools used in agriculture, horticulture or forestry', w: 'kudal spade axe sickle hasua phawda' },
  { hsn: '8467', desc: 'Tools for working in the hand, with self-contained motor', w: 'drill machine grinder power tool' },
  { hsn: '3214', desc: 'Glaziers putty; painters fillings; sealants', w: 'putty sealant m seal white cement' },
  { hsn: '4418', desc: 'Builders joinery and carpentry of wood', w: 'wooden door window frame plywood door' },
  { hsn: '4412', desc: 'Plywood, veneered panels and similar laminated wood', w: 'plywood ply board laminate sunmica' },
  { hsn: '7005', desc: 'Float glass and surface ground or polished glass', w: 'glass sheet mirror glass' },
  { hsn: '7009', desc: 'Glass mirrors, whether or not framed', w: 'mirror sheesha' },
  { hsn: '8544', desc: 'Insulated wire, cable and other insulated electric conductors', w: 'wire cable electric wire' },
  { hsn: '8536', desc: 'Electrical apparatus for switching or protecting circuits', w: 'switch socket mcb holder plug board' },
  { hsn: '8537', desc: 'Boards, panels and consoles for electric control', w: 'db box panel board' },
  { hsn: '9405', desc: 'Luminaires and lighting fittings', w: 'bulb led tube light lamp fitting jhumar' },
  { hsn: '8539', desc: 'Electric filament or discharge lamps', w: 'bulb cfl tube light halogen' },
  { hsn: '8414', desc: 'Air or vacuum pumps, fans and ventilating hoods', w: 'fan exhaust fan table fan cooler pump' },
  { hsn: '8413', desc: 'Pumps for liquids', w: 'water pump motor submersible' },
  { hsn: '8501', desc: 'Electric motors and generators', w: 'motor generator' },
  { hsn: '8516', desc: 'Electric water heaters, irons, ovens and heating apparatus', w: 'iron heater geyser kettle induction toaster' },
  { hsn: '8509', desc: 'Electro-mechanical domestic appliances', w: 'mixer grinder juicer food processor' },
  { hsn: '8418', desc: 'Refrigerators, freezers and other refrigerating equipment', w: 'fridge refrigerator deep freezer' },
  { hsn: '8415', desc: 'Air conditioning machines', w: 'ac air conditioner split ac' },
  { hsn: '8450', desc: 'Household or laundry-type washing machines', w: 'washing machine' },
  { hsn: '8528', desc: 'Monitors and projectors; television receivers', w: 'tv television led tv monitor' },
  { hsn: '8517', desc: 'Telephone sets, including smartphones', w: 'mobile phone smartphone telephone' },
  { hsn: '8507', desc: 'Electric accumulators, including separators', w: 'battery inverter battery' },
  { hsn: '8506', desc: 'Primary cells and primary batteries', w: 'cell pencil cell battery torch cell' },
  { hsn: '8504', desc: 'Electrical transformers, static converters and inductors', w: 'inverter stabiliser transformer charger adapter' },
  { hsn: '8513', desc: 'Portable electric lamps designed to function by their own source', w: 'torch emergency light' },
  { hsn: '8471', desc: 'Automatic data processing machines (computers)', w: 'computer laptop printer cpu' },
  { hsn: '8523', desc: 'Discs, tapes and other media for recording', w: 'pen drive memory card cd dvd' },

  /* ---------------- HOUSEHOLD, KITCHEN, PLASTICS ---------------- */
  { hsn: '3923', desc: 'Articles for the conveyance or packing of goods, of plastics', w: 'plastic container jar carry bag packing plastic bottle' },
  { hsn: '3926', desc: 'Other articles of plastics', w: 'plastic item hanger clip plastic goods' },
  { hsn: '6911', desc: 'Tableware and kitchenware of porcelain or china', w: 'crockery cup plate china' },
  { hsn: '6912', desc: 'Ceramic tableware and kitchenware other than porcelain', w: 'ceramic cup mug plate' },
  { hsn: '7013', desc: 'Glassware of a kind used for table, kitchen or toilet', w: 'glass tumbler bowl glassware' },
  { hsn: '7310', desc: 'Tanks, casks, drums of iron or steel, up to 300 litres', w: 'drum tin can barrel' },
  { hsn: '7615', desc: 'Table, kitchen or other household articles of aluminium', w: 'aluminium balty patila handi tope' },
  { hsn: '9603', desc: 'Brooms, brushes, mops and feather dusters', w: 'jhadu broom brush mop wiper' },
  { hsn: '9604', desc: 'Hand sieves and hand riddles', w: 'chalni sieve' },
  { hsn: '4602', desc: 'Basketwork, wickerwork and other articles of plaiting materials', w: 'basket tokri cane' },
  { hsn: '6304', desc: 'Other furnishing articles', w: 'curtain parda cushion cover' },
  { hsn: '9615', desc: 'Combs, hair-slides and the like', w: 'comb kangha clip hair band' },
  { hsn: '9605', desc: 'Travel sets for personal toilet, sewing or shoe cleaning', w: 'travel set kit' },
  { hsn: '4202', desc: 'Trunks, suitcases, handbags, wallets and similar containers', w: 'bag suitcase school bag purse wallet trolley' },
  { hsn: '6601', desc: 'Umbrellas and sun umbrellas', w: 'umbrella chata' },
  { hsn: '9613', desc: 'Cigarette lighters and other lighters', w: 'lighter' },
  { hsn: '3605', desc: 'Matches', w: 'matchbox diyasalai match' },
  { hsn: '9602', desc: 'Worked vegetable or mineral carving material', w: 'agarbatti dhoop incense' },
  { hsn: '3307', desc: 'Agarbatti and other odoriferous preparations', w: 'agarbatti dhoop batti' },

  /* ---------------- VEHICLES, TYRES, PARTS ---------------- */
  { hsn: '8711', desc: 'Motorcycles and cycles fitted with an auxiliary motor', w: 'bike motorcycle scooter' },
  { hsn: '8712', desc: 'Bicycles and other cycles, not motorised', w: 'cycle bicycle' },
  { hsn: '8714', desc: 'Parts and accessories of cycles and motorcycles', w: 'cycle part bike part spare' },
  { hsn: '8708', desc: 'Parts and accessories of motor vehicles', w: 'car part auto part spare' },
  { hsn: '4011', desc: 'New pneumatic tyres of rubber', w: 'tyre tire' },
  { hsn: '4013', desc: 'Inner tubes of rubber', w: 'tube inner tube' },

  /* ---------------- AGRICULTURE ---------------- */
  { hsn: '3102', desc: 'Mineral or chemical fertilisers, nitrogenous', w: 'urea fertiliser khad' },
  { hsn: '3105', desc: 'Mineral or chemical fertilisers containing two or three nutrients', w: 'npk dap fertiliser khad' },
  { hsn: '1209', desc: 'Seeds, fruit and spores of a kind used for sowing', w: 'seed beej' },
  { hsn: '2309', desc: 'Preparations of a kind used in animal feeding', w: 'cattle feed poultry feed chara' },
  { hsn: '2302', desc: 'Bran, sharps and other residues from working cereals', w: 'chokar bran' },

  /* ---------------- SERVICES a shop commonly bills ---------------- */
  { hsn: '9965', desc: 'Goods transport services', w: 'transport freight carriage lorry' },
  { hsn: '9967', desc: 'Supporting services in transport', w: 'loading unloading cartage handling' },
  { hsn: '9988', desc: 'Manufacturing services on physical inputs owned by others', w: 'job work labour charge' },
  { hsn: '9987', desc: 'Maintenance, repair and installation services', w: 'repair service installation fitting amc' },
  { hsn: '9954', desc: 'Construction services', w: 'construction contract labour work' },
  { hsn: '9983', desc: 'Other professional, technical and business services', w: 'consultancy professional fee' },
  { hsn: '9963', desc: 'Accommodation, food and beverage services', w: 'hotel restaurant catering tiffin' },
  { hsn: '9985', desc: 'Support services', w: 'manpower security housekeeping' },
  { hsn: '9973', desc: 'Leasing or rental services', w: 'rent hire lease' },
];

// ONE ENTRY PER CODE, BUT NOTHING THROWN AWAY.
//
// The list above is written by trade, so a heading a chemist and a kirana
// both stock gets written twice — once with a chemist's words on it and once
// with a grocer's. Keeping only the first would lose half the search words
// and silently drop the `supply` and `gst_rate` the second entry carried. So
// the two are MERGED: the longer description wins, the shop words are pooled,
// and anything either one knows is kept.
const dedupe = (list) => {
  const by = new Map();
  for (const m of list || []) {
    const k = String(m?.hsn || '').trim();
    if (!k) continue;
    const had = by.get(k);
    if (!had) { by.set(k, { ...m, hsn: k }); continue; }
    const words = new Set(
      `${had.w || ''} ${m.w || ''}`.toLowerCase().split(/\s+/).filter(Boolean));
    by.set(k, {
      ...had,
      ...m,
      hsn: k,
      // the fuller description is the more useful one to show
      desc: (String(m.desc || '').length > String(had.desc || '').length ? m.desc : had.desc),
      w: [...words].join(' '),
      supply: m.supply || had.supply,
      gst_rate: m.gst_rate ?? had.gst_rate,
    });
  }
  return [...by.values()];
};
MASTER = dedupe(MASTER);

// Swap in the full master downloaded from the GST portal.
// Each entry needs { hsn, desc } and may add { gst_rate }, { supply } and { w }.
// `w` is the shop words a trader would actually type - bucket, sariya, jhadu.
export function setHsnMaster(list) {
  if (Array.isArray(list) && list.length) MASTER = dedupe(list);
}

// What kind of supply a code is, where that is settled by law rather than by
// a notification that can change — petrol, liquor and electricity are outside
// GST by the Constitution. Everything else answers 'taxable' and the
// shopkeeper sets nil or exempt himself on the item.
export const hsnSupply = (hsn) => {
  const s = String(hsn || '').trim();
  const m = MASTER.find((x) => x.hsn === s) || MASTER.find((x) => x.hsn === s.slice(0, 4));
  return m?.supply || 'taxable';
};
export const hsnMasterSize = () => MASTER.length;

// How many digits this firm must use. The question is asked once, at sign-up.
export const minHsnDigits = (org) => (org?.turnover_above_5cr ? 6 : 4);

// Shape check. Returns null when fine, or a sentence to show the shopkeeper.
export function checkHsn(hsn, org) {
  const s = String(hsn || '').trim();
  // not registered, or a composition dealer who switched HSN off
  if (!org?.is_gst_registered) return null;
  if (org?.is_composition && org?.hsn_enabled === false) return null;
  if (!s) return 'HSN code is needed on a GST bill.';
  if (!/^\d+$/.test(s)) return 'An HSN code is numbers only.';
  if (![4, 6, 8].includes(s.length)) return 'An HSN code is 4, 6 or 8 digits.';
  const need = minHsnDigits(org);
  if (s.length < need) {
    return org.turnover_above_5cr
      ? 'Your turnover is above ₹5 crore, so HSN must be at least 6 digits.'
      : 'HSN must be at least 4 digits.';
  }
  return null;
}

// Does it exist in the loaded master? A 6 or 8 digit code is checked by its
// first 4 digits, because the starter list holds 4-digit headings only.
export const hsnExists = (hsn) => {
  const s = String(hsn || '').trim();
  return MASTER.some((m) => m.hsn === s) || MASTER.some((m) => m.hsn === s.slice(0, 4));
};

export const hsnDesc = (hsn) => {
  const s = String(hsn || '').trim();
  return (MASTER.find((m) => m.hsn === s) || MASTER.find((m) => m.hsn === s.slice(0, 4)))?.desc || '';
};

// Search by number or by words: "bucket" and "3924" both find plastics.
export function searchHsn(q, limit = 12) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return MASTER.slice(0, limit);
  const words = s.split(/\s+/).filter(Boolean);
  const score = (m) => {
    const d = m.desc.toLowerCase();
    const k = (m.w || '').toLowerCase();          // shop words: bucket, sariya, jhadu
    const both = `${d} ${k}`;
    if (m.hsn === s) return 0;
    if (m.hsn.startsWith(s)) return 1;
    if (k.split(/\s+/).includes(s)) return 2;      // exact shop word wins
    if (d.startsWith(s)) return 3;
    if (words.every((w) => both.includes(w))) return 4;
    if (words.some((w) => w.length > 2 && both.includes(w))) return 5;
    return 99;
  };
  return MASTER.map((m) => [score(m), m]).filter(([x]) => x < 99)
    .sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, m]) => m);
}
