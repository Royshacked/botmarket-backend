# DRAFT FMP industry -> GICS sub-industry. Judgment, for review. One primary sub-industry per FMP
# industry; SPLIT marks an FMP industry that really spans several GICS sub-industries (its companies
# would need per-company assignment, e.g. by SIC code, to land correctly). None = no GICS equity home
# (shells, closed-end funds), excluded from the industry answers.
SPLIT = 'split'
M = {
 # Basic Materials
 'Steel': ('Steel', None), 'Silver': ('Silver', None), 'Gold': ('Gold', None), 'Copper': ('Copper', None),
 'Other Precious Metals': ('Precious Metals & Minerals', None), 'Aluminum': ('Aluminum', None),
 'Paper, Lumber & Forest Products': ('Forest Products', SPLIT),           # + Paper Products
 'Industrial Materials': ('Diversified Metals & Mining', None),
 'Construction Materials': ('Construction Materials', None),
 'Chemicals - Specialty': ('Specialty Chemicals', SPLIT),                 # + Industrial Gases
 'Chemicals': ('Commodity Chemicals', SPLIT),                             # + Diversified Chemicals
 'Agricultural Inputs': ('Fertilizers & Agricultural Chemicals', None),
 # Communication Services
 'Telecommunications Services': ('Integrated Telecommunication Services', SPLIT),  # + Wireless, Alternative Carriers, Cable & Satellite
 'Internet Content & Information': ('Interactive Media & Services', None),
 'Publishing': ('Publishing', None), 'Broadcasting': ('Broadcasting', None),
 'Advertising Agencies': ('Advertising', None),
 'Entertainment': ('Movies & Entertainment', None),
 # Consumer Cyclical
 'Travel Lodging': ('Hotels, Resorts & Cruise Lines', None),
 'Travel Services': ('Hotels, Resorts & Cruise Lines', None),
 'Specialty Retail': ('Other Specialty Retail', SPLIT),                   # + Computer & Electronics, Automotive Retail
 'Luxury Goods': ('Apparel, Accessories & Luxury Goods', None),
 'Home Improvement': ('Home Improvement Retail', None),
 'Residential Construction': ('Homebuilding', None),
 'Department Stores': ('Broadline Retail', None),
 'Personal Products & Services': ('Specialized Consumer Services', None),
 'Leisure': ('Leisure Products', SPLIT),                                  # + Leisure Facilities
 'Gambling, Resorts & Casinos': ('Casinos & Gaming', None),
 'Furnishings, Fixtures & Appliances': ('Home Furnishings', SPLIT),       # + Household Appliances, Housewares
 'Restaurants': ('Restaurants', None),
 'Auto - Parts': ('Automotive Parts & Equipment', SPLIT),                 # + Tires & Rubber
 'Auto - Manufacturers': ('Automobile Manufacturers', None),
 'Auto - Recreational Vehicles': ('Motorcycle Manufacturers', None),
 'Auto - Dealerships': ('Automotive Retail', None),
 'Apparel - Retail': ('Apparel Retail', None),
 'Apparel - Manufacturers': ('Apparel, Accessories & Luxury Goods', SPLIT),  # + Textiles
 'Apparel - Footwear & Accessories': ('Footwear', None),
 'Packaging & Containers': ('Paper & Plastic Packaging Products & Materials', SPLIT),  # + Metal, Glass & Plastic Containers
 # Consumer Defensive
 'Tobacco': ('Tobacco', None), 'Grocery Stores': ('Food Retail', None),
 'Discount Stores': ('Consumer Staples Merchandise Retail', None),
 'Household & Personal Products': ('Household Products', SPLIT),         # + Personal Care Products
 'Packaged Foods': ('Packaged Foods & Meats', None),
 'Food Distribution': ('Food Distributors', None),
 'Food Confectioners': ('Packaged Foods & Meats', None),
 'Agricultural Farm Products': ('Agricultural Products & Services', None),
 'Education & Training Services': ('Education Services', None),
 'Beverages - Wineries & Distilleries': ('Distillers & Vintners', None),
 'Beverages - Non-Alcoholic': ('Soft Drinks & Non-alcoholic Beverages', None),
 'Beverages - Alcoholic': ('Brewers', SPLIT),                             # + Distillers & Vintners
 # Energy
 'Uranium': ('Coal & Consumable Fuels', None), 'Coal': ('Coal & Consumable Fuels', None),
 'Solar': ('Semiconductors', SPLIT),                                      # GICS splits solar across semis / electrical equipment / renewables
 'Oil & Gas Refining & Marketing': ('Oil & Gas Refining & Marketing', None),
 'Oil & Gas Midstream': ('Oil & Gas Storage & Transportation', None),
 'Oil & Gas Integrated': ('Integrated Oil & Gas', None),
 'Oil & Gas Exploration & Production': ('Oil & Gas Exploration & Production', None),
 'Oil & Gas Equipment & Services': ('Oil & Gas Equipment & Services', None),
 'Oil & Gas Energy': ('Oil & Gas Exploration & Production', None),
 'Oil & Gas Drilling': ('Oil & Gas Drilling', None),
 # Financial Services
 'Shell Companies': (None, None),
 'Investment - Banking & Investment Services': ('Investment Banking & Brokerage', None),
 'Insurance - Specialty': ('Property & Casualty Insurance', None),
 'Insurance - Reinsurance': ('Reinsurance', None),
 'Insurance - Property & Casualty': ('Property & Casualty Insurance', None),
 'Insurance - Life': ('Life & Health Insurance', None),
 'Insurance - Diversified': ('Multi-line Insurance', None),
 'Insurance - Brokers': ('Insurance Brokers', None),
 'Financial - Mortgages': ('Commercial & Residential Mortgage Finance', None),
 'Financial - Data & Stock Exchanges': ('Financial Exchanges & Data', None),
 'Financial - Credit Services': ('Consumer Finance', SPLIT),              # + Transaction & Payment Processing
 'Financial - Conglomerates': ('Multi-Sector Holdings', None),
 'Financial - Capital Markets': ('Investment Banking & Brokerage', SPLIT),   # + Diversified Capital Markets, Specialized Finance
 'Banks - Regional': ('Regional Banks', None),
 'Banks - Diversified': ('Diversified Banks', None),
 'Banks': ('Regional Banks', None),
 'Asset Management': ('Asset Management & Custody Banks', None),
 'Asset Management - Bonds': (None, None), 'Asset Management - Income': (None, None),
 'Asset Management - Leveraged': (None, None), 'Asset Management - Cryptocurrency': (None, None),
 'Asset Management - Global': (None, None),
 # Healthcare
 'Medical - Specialties': ('Health Care Equipment', None),
 'Medical - Pharmaceuticals': ('Pharmaceuticals', None),
 'Medical - Instruments & Supplies': ('Health Care Supplies', None),
 'Medical - Healthcare Plans': ('Managed Health Care', None),
 'Medical - Healthcare Information Services': ('Health Care Technology', None),
 'Medical - Equipment & Services': ('Health Care Equipment', None),
 'Medical - Distribution': ('Health Care Distributors', None),
 'Medical - Diagnostics & Research': ('Life Sciences Tools & Services', SPLIT),  # + Health Care Services (labs)
 'Medical - Devices': ('Health Care Equipment', None),
 'Medical - Care Facilities': ('Health Care Facilities', SPLIT),         # + Health Care Services
 'Drug Manufacturers - Specialty & Generic': ('Pharmaceuticals', None),
 'Drug Manufacturers - General': ('Pharmaceuticals', None),
 'Biotechnology': ('Biotechnology', None),
 # Industrials
 'Waste Management': ('Environmental & Facilities Services', None),
 'Environmental Services': ('Environmental & Facilities Services', None),
 'Trucking': ('Cargo Ground Transportation', None),
 'Railroads': ('Rail Transportation', None),
 'Aerospace & Defense': ('Aerospace & Defense', None),
 'Marine Shipping': ('Marine Transportation', None),
 'Integrated Freight & Logistics': ('Air Freight & Logistics', None),
 'Airlines, Airports & Air Services': ('Passenger Airlines', SPLIT),      # + Airport Services
 'General Transportation': ('Passenger Ground Transportation', SPLIT),
 'Manufacturing - Tools & Accessories': ('Industrial Machinery & Supplies & Components', None),
 'Manufacturing - Textiles': ('Textiles', None),
 'Manufacturing - Miscellaneous': ('Industrial Machinery & Supplies & Components', None),
 'Manufacturing - Metal Fabrication': ('Industrial Machinery & Supplies & Components', None),
 'Industrial - Distribution': ('Trading Companies & Distributors', None),
 'Industrial - Specialties': ('Industrial Machinery & Supplies & Components', None),
 'Industrial - Pollution & Treatment Controls': ('Industrial Machinery & Supplies & Components', None),
 'Industrial - Machinery': ('Industrial Machinery & Supplies & Components', SPLIT),  # + Construction Machinery & Heavy Transport Eq.
 'Industrial - Infrastructure Operations': ('Construction & Engineering', None),
 'Consulting Services': ('Research & Consulting Services', None),
 'Business Equipment & Supplies': ('Office Services & Supplies', None),
 'Staffing & Employment Services': ('Human Resource & Employment Services', None),
 'Rental & Leasing Services': ('Trading Companies & Distributors', None),
 'Engineering & Construction': ('Construction & Engineering', None),
 'Construction': ('Building Products', None),
 'Security & Protection Services': ('Security & Alarm Services', None),
 'Specialty Business Services': ('Diversified Support Services', SPLIT),  # + Commercial Printing, Data Processing
 'Conglomerates': ('Industrial Conglomerates', None),
 'Electrical Equipment & Parts': ('Electrical Components & Equipment', SPLIT),  # + Heavy Electrical Equipment
 'Agricultural - Machinery': ('Agricultural & Farm Machinery', None),
 'Agricultural - Commodities/Milling': ('Agricultural Products & Services', None),
 # Real Estate
 'REIT - Specialty': ('Other Specialized REITs', SPLIT),                  # + Towers, Data Centers, Self-Storage, Timber
 'REIT - Retail': ('Retail REITs', None), 'REIT - Office': ('Office REITs', None),
 'REIT - Residential': ('Multi-Family Residential REITs', SPLIT),          # + Single-Family
 'REIT - Mortgage': ('Mortgage REITs', None), 'REIT - Industrial': ('Industrial REITs', None),
 'REIT - Hotel & Motel': ('Hotel & Resort REITs', None),
 'REIT - Healthcare Facilities': ('Health Care REITs', None),
 'REIT - Diversified': ('Diversified REITs', None),
 'Real Estate - Services': ('Real Estate Services', None),
 'Real Estate - Diversified': ('Diversified Real Estate Activities', None),
 'Real Estate - Development': ('Real Estate Development', None),
 # Technology
 'Information Technology Services': ('IT Consulting & Other Services', None),
 'Hardware, Equipment & Parts': ('Electronic Components', SPLIT),         # + Electronic Equipment & Instruments, EMS
 'Computer Hardware': ('Technology Hardware, Storage & Peripherals', None),
 'Electronic Gaming & Multimedia': ('Interactive Home Entertainment', None),
 'Software - Services': ('Application Software', None),
 'Software - Infrastructure': ('Systems Software', SPLIT),                # + Internet Services & Infrastructure
 'Software - Application': ('Application Software', None),
 'Semiconductors': ('Semiconductors', SPLIT),                             # + Semiconductor Materials & Equipment
 'Media & Entertainment': ('Movies & Entertainment', None),
 'Communication Equipment': ('Communications Equipment', None),
 'Technology Distributors': ('Technology Distributors', None),
 'Consumer Electronics': ('Consumer Electronics', None),
 # Utilities
 'Renewable Utilities': ('Renewable Electricity', None),
 'Regulated Water': ('Water Utilities', None), 'Regulated Gas': ('Gas Utilities', None),
 'Regulated Electric': ('Electric Utilities', None),
 'Independent Power Producers': ('Independent Power Producers & Energy Traders', None),
 'Diversified Utilities': ('Multi-Utilities', None),
}
