
-- ============================================================
-- PHASE 1: Global Countries Table + Seed ~250 ISO Countries
-- PHASE 2: Localization Pack Infrastructure Tables
-- ============================================================

-- 1. Create countries table
CREATE TABLE public.countries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  official_name TEXT,
  region TEXT,
  default_currency TEXT,
  phone_code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable RLS (public read, admin write)
ALTER TABLE public.countries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Countries are publicly readable"
  ON public.countries FOR SELECT
  USING (true);

-- Index for fast lookup
CREATE INDEX idx_countries_code ON public.countries (code);
CREATE INDEX idx_countries_name ON public.countries (name);

-- 2. Seed all ~250 ISO 3166-1 countries
INSERT INTO public.countries (code, name, official_name, region, default_currency, phone_code) VALUES
-- Africa
('DZ', 'Algeria', 'People''s Democratic Republic of Algeria', 'Africa', 'DZD', '+213'),
('AO', 'Angola', 'Republic of Angola', 'Africa', 'AOA', '+244'),
('BJ', 'Benin', 'Republic of Benin', 'Africa', 'XOF', '+229'),
('BW', 'Botswana', 'Republic of Botswana', 'Africa', 'BWP', '+267'),
('BF', 'Burkina Faso', 'Burkina Faso', 'Africa', 'XOF', '+226'),
('BI', 'Burundi', 'Republic of Burundi', 'Africa', 'BIF', '+257'),
('CV', 'Cabo Verde', 'Republic of Cabo Verde', 'Africa', 'CVE', '+238'),
('CM', 'Cameroon', 'Republic of Cameroon', 'Africa', 'XAF', '+237'),
('CF', 'Central African Republic', 'Central African Republic', 'Africa', 'XAF', '+236'),
('TD', 'Chad', 'Republic of Chad', 'Africa', 'XAF', '+235'),
('KM', 'Comoros', 'Union of the Comoros', 'Africa', 'KMF', '+269'),
('CG', 'Congo', 'Republic of the Congo', 'Africa', 'XAF', '+242'),
('CD', 'Congo (DRC)', 'Democratic Republic of the Congo', 'Africa', 'CDF', '+243'),
('CI', 'Côte d''Ivoire', 'Republic of Côte d''Ivoire', 'Africa', 'XOF', '+225'),
('DJ', 'Djibouti', 'Republic of Djibouti', 'Africa', 'DJF', '+253'),
('EG', 'Egypt', 'Arab Republic of Egypt', 'Africa', 'EGP', '+20'),
('GQ', 'Equatorial Guinea', 'Republic of Equatorial Guinea', 'Africa', 'XAF', '+240'),
('ER', 'Eritrea', 'State of Eritrea', 'Africa', 'ERN', '+291'),
('SZ', 'Eswatini', 'Kingdom of Eswatini', 'Africa', 'SZL', '+268'),
('ET', 'Ethiopia', 'Federal Democratic Republic of Ethiopia', 'Africa', 'ETB', '+251'),
('GA', 'Gabon', 'Gabonese Republic', 'Africa', 'XAF', '+241'),
('GM', 'Gambia', 'Republic of The Gambia', 'Africa', 'GMD', '+220'),
('GH', 'Ghana', 'Republic of Ghana', 'Africa', 'GHS', '+233'),
('GN', 'Guinea', 'Republic of Guinea', 'Africa', 'GNF', '+224'),
('GW', 'Guinea-Bissau', 'Republic of Guinea-Bissau', 'Africa', 'XOF', '+245'),
('KE', 'Kenya', 'Republic of Kenya', 'Africa', 'KES', '+254'),
('LS', 'Lesotho', 'Kingdom of Lesotho', 'Africa', 'LSL', '+266'),
('LR', 'Liberia', 'Republic of Liberia', 'Africa', 'LRD', '+231'),
('LY', 'Libya', 'State of Libya', 'Africa', 'LYD', '+218'),
('MG', 'Madagascar', 'Republic of Madagascar', 'Africa', 'MGA', '+261'),
('MW', 'Malawi', 'Republic of Malawi', 'Africa', 'MWK', '+265'),
('ML', 'Mali', 'Republic of Mali', 'Africa', 'XOF', '+223'),
('MR', 'Mauritania', 'Islamic Republic of Mauritania', 'Africa', 'MRU', '+222'),
('MU', 'Mauritius', 'Republic of Mauritius', 'Africa', 'MUR', '+230'),
('MA', 'Morocco', 'Kingdom of Morocco', 'Africa', 'MAD', '+212'),
('MZ', 'Mozambique', 'Republic of Mozambique', 'Africa', 'MZN', '+258'),
('NA', 'Namibia', 'Republic of Namibia', 'Africa', 'NAD', '+264'),
('NE', 'Niger', 'Republic of Niger', 'Africa', 'XOF', '+227'),
('NG', 'Nigeria', 'Federal Republic of Nigeria', 'Africa', 'NGN', '+234'),
('RW', 'Rwanda', 'Republic of Rwanda', 'Africa', 'RWF', '+250'),
('ST', 'São Tomé and Príncipe', 'Democratic Republic of São Tomé and Príncipe', 'Africa', 'STN', '+239'),
('SN', 'Senegal', 'Republic of Senegal', 'Africa', 'XOF', '+221'),
('SC', 'Seychelles', 'Republic of Seychelles', 'Africa', 'SCR', '+248'),
('SL', 'Sierra Leone', 'Republic of Sierra Leone', 'Africa', 'SLE', '+232'),
('SO', 'Somalia', 'Federal Republic of Somalia', 'Africa', 'SOS', '+252'),
('ZA', 'South Africa', 'Republic of South Africa', 'Africa', 'ZAR', '+27'),
('SS', 'South Sudan', 'Republic of South Sudan', 'Africa', 'SSP', '+211'),
('SD', 'Sudan', 'Republic of the Sudan', 'Africa', 'SDG', '+249'),
('TZ', 'Tanzania', 'United Republic of Tanzania', 'Africa', 'TZS', '+255'),
('TG', 'Togo', 'Togolese Republic', 'Africa', 'XOF', '+228'),
('TN', 'Tunisia', 'Republic of Tunisia', 'Africa', 'TND', '+216'),
('UG', 'Uganda', 'Republic of Uganda', 'Africa', 'UGX', '+256'),
('ZM', 'Zambia', 'Republic of Zambia', 'Africa', 'ZMW', '+260'),
('ZW', 'Zimbabwe', 'Republic of Zimbabwe', 'Africa', 'ZWL', '+263'),

-- Europe
('AL', 'Albania', 'Republic of Albania', 'Europe', 'ALL', '+355'),
('AD', 'Andorra', 'Principality of Andorra', 'Europe', 'EUR', '+376'),
('AT', 'Austria', 'Republic of Austria', 'Europe', 'EUR', '+43'),
('BY', 'Belarus', 'Republic of Belarus', 'Europe', 'BYN', '+375'),
('BE', 'Belgium', 'Kingdom of Belgium', 'Europe', 'EUR', '+32'),
('BA', 'Bosnia and Herzegovina', 'Bosnia and Herzegovina', 'Europe', 'BAM', '+387'),
('BG', 'Bulgaria', 'Republic of Bulgaria', 'Europe', 'BGN', '+359'),
('HR', 'Croatia', 'Republic of Croatia', 'Europe', 'EUR', '+385'),
('CY', 'Cyprus', 'Republic of Cyprus', 'Europe', 'EUR', '+357'),
('CZ', 'Czech Republic', 'Czech Republic', 'Europe', 'CZK', '+420'),
('DK', 'Denmark', 'Kingdom of Denmark', 'Europe', 'DKK', '+45'),
('EE', 'Estonia', 'Republic of Estonia', 'Europe', 'EUR', '+372'),
('FI', 'Finland', 'Republic of Finland', 'Europe', 'EUR', '+358'),
('FR', 'France', 'French Republic', 'Europe', 'EUR', '+33'),
('DE', 'Germany', 'Federal Republic of Germany', 'Europe', 'EUR', '+49'),
('GR', 'Greece', 'Hellenic Republic', 'Europe', 'EUR', '+30'),
('HU', 'Hungary', 'Hungary', 'Europe', 'HUF', '+36'),
('IS', 'Iceland', 'Iceland', 'Europe', 'ISK', '+354'),
('IE', 'Ireland', 'Ireland', 'Europe', 'EUR', '+353'),
('IT', 'Italy', 'Italian Republic', 'Europe', 'EUR', '+39'),
('XK', 'Kosovo', 'Republic of Kosovo', 'Europe', 'EUR', '+383'),
('LV', 'Latvia', 'Republic of Latvia', 'Europe', 'EUR', '+371'),
('LI', 'Liechtenstein', 'Principality of Liechtenstein', 'Europe', 'CHF', '+423'),
('LT', 'Lithuania', 'Republic of Lithuania', 'Europe', 'EUR', '+370'),
('LU', 'Luxembourg', 'Grand Duchy of Luxembourg', 'Europe', 'EUR', '+352'),
('MT', 'Malta', 'Republic of Malta', 'Europe', 'EUR', '+356'),
('MD', 'Moldova', 'Republic of Moldova', 'Europe', 'MDL', '+373'),
('MC', 'Monaco', 'Principality of Monaco', 'Europe', 'EUR', '+377'),
('ME', 'Montenegro', 'Montenegro', 'Europe', 'EUR', '+382'),
('NL', 'Netherlands', 'Kingdom of the Netherlands', 'Europe', 'EUR', '+31'),
('MK', 'North Macedonia', 'Republic of North Macedonia', 'Europe', 'MKD', '+389'),
('NO', 'Norway', 'Kingdom of Norway', 'Europe', 'NOK', '+47'),
('PL', 'Poland', 'Republic of Poland', 'Europe', 'PLN', '+48'),
('PT', 'Portugal', 'Portuguese Republic', 'Europe', 'EUR', '+351'),
('RO', 'Romania', 'Romania', 'Europe', 'RON', '+40'),
('RU', 'Russia', 'Russian Federation', 'Europe', 'RUB', '+7'),
('SM', 'San Marino', 'Republic of San Marino', 'Europe', 'EUR', '+378'),
('RS', 'Serbia', 'Republic of Serbia', 'Europe', 'RSD', '+381'),
('SK', 'Slovakia', 'Slovak Republic', 'Europe', 'EUR', '+421'),
('SI', 'Slovenia', 'Republic of Slovenia', 'Europe', 'EUR', '+386'),
('ES', 'Spain', 'Kingdom of Spain', 'Europe', 'EUR', '+34'),
('SE', 'Sweden', 'Kingdom of Sweden', 'Europe', 'SEK', '+46'),
('CH', 'Switzerland', 'Swiss Confederation', 'Europe', 'CHF', '+41'),
('UA', 'Ukraine', 'Ukraine', 'Europe', 'UAH', '+380'),
('GB', 'United Kingdom', 'United Kingdom of Great Britain and Northern Ireland', 'Europe', 'GBP', '+44'),
('VA', 'Vatican City', 'Vatican City State', 'Europe', 'EUR', '+39'),

-- Americas
('AG', 'Antigua and Barbuda', 'Antigua and Barbuda', 'Americas', 'XCD', '+1-268'),
('AR', 'Argentina', 'Argentine Republic', 'Americas', 'ARS', '+54'),
('BS', 'Bahamas', 'Commonwealth of The Bahamas', 'Americas', 'BSD', '+1-242'),
('BB', 'Barbados', 'Barbados', 'Americas', 'BBD', '+1-246'),
('BZ', 'Belize', 'Belize', 'Americas', 'BZD', '+501'),
('BO', 'Bolivia', 'Plurinational State of Bolivia', 'Americas', 'BOB', '+591'),
('BR', 'Brazil', 'Federative Republic of Brazil', 'Americas', 'BRL', '+55'),
('CA', 'Canada', 'Canada', 'Americas', 'CAD', '+1'),
('CL', 'Chile', 'Republic of Chile', 'Americas', 'CLP', '+56'),
('CO', 'Colombia', 'Republic of Colombia', 'Americas', 'COP', '+57'),
('CR', 'Costa Rica', 'Republic of Costa Rica', 'Americas', 'CRC', '+506'),
('CU', 'Cuba', 'Republic of Cuba', 'Americas', 'CUP', '+53'),
('DM', 'Dominica', 'Commonwealth of Dominica', 'Americas', 'XCD', '+1-767'),
('DO', 'Dominican Republic', 'Dominican Republic', 'Americas', 'DOP', '+1-809'),
('EC', 'Ecuador', 'Republic of Ecuador', 'Americas', 'USD', '+593'),
('SV', 'El Salvador', 'Republic of El Salvador', 'Americas', 'USD', '+503'),
('GD', 'Grenada', 'Grenada', 'Americas', 'XCD', '+1-473'),
('GT', 'Guatemala', 'Republic of Guatemala', 'Americas', 'GTQ', '+502'),
('GY', 'Guyana', 'Co-operative Republic of Guyana', 'Americas', 'GYD', '+592'),
('HT', 'Haiti', 'Republic of Haiti', 'Americas', 'HTG', '+509'),
('HN', 'Honduras', 'Republic of Honduras', 'Americas', 'HNL', '+504'),
('JM', 'Jamaica', 'Jamaica', 'Americas', 'JMD', '+1-876'),
('MX', 'Mexico', 'United Mexican States', 'Americas', 'MXN', '+52'),
('NI', 'Nicaragua', 'Republic of Nicaragua', 'Americas', 'NIO', '+505'),
('PA', 'Panama', 'Republic of Panama', 'Americas', 'PAB', '+507'),
('PY', 'Paraguay', 'Republic of Paraguay', 'Americas', 'PYG', '+595'),
('PE', 'Peru', 'Republic of Peru', 'Americas', 'PEN', '+51'),
('KN', 'Saint Kitts and Nevis', 'Federation of Saint Christopher and Nevis', 'Americas', 'XCD', '+1-869'),
('LC', 'Saint Lucia', 'Saint Lucia', 'Americas', 'XCD', '+1-758'),
('VC', 'Saint Vincent and the Grenadines', 'Saint Vincent and the Grenadines', 'Americas', 'XCD', '+1-784'),
('SR', 'Suriname', 'Republic of Suriname', 'Americas', 'SRD', '+597'),
('TT', 'Trinidad and Tobago', 'Republic of Trinidad and Tobago', 'Americas', 'TTD', '+1-868'),
('US', 'United States', 'United States of America', 'Americas', 'USD', '+1'),
('UY', 'Uruguay', 'Eastern Republic of Uruguay', 'Americas', 'UYU', '+598'),
('VE', 'Venezuela', 'Bolivarian Republic of Venezuela', 'Americas', 'VES', '+58'),

-- Asia
('AF', 'Afghanistan', 'Islamic Republic of Afghanistan', 'Asia', 'AFN', '+93'),
('AM', 'Armenia', 'Republic of Armenia', 'Asia', 'AMD', '+374'),
('AZ', 'Azerbaijan', 'Republic of Azerbaijan', 'Asia', 'AZN', '+994'),
('BH', 'Bahrain', 'Kingdom of Bahrain', 'Asia', 'BHD', '+973'),
('BD', 'Bangladesh', 'People''s Republic of Bangladesh', 'Asia', 'BDT', '+880'),
('BT', 'Bhutan', 'Kingdom of Bhutan', 'Asia', 'BTN', '+975'),
('BN', 'Brunei', 'Brunei Darussalam', 'Asia', 'BND', '+673'),
('KH', 'Cambodia', 'Kingdom of Cambodia', 'Asia', 'KHR', '+855'),
('CN', 'China', 'People''s Republic of China', 'Asia', 'CNY', '+86'),
('GE', 'Georgia', 'Georgia', 'Asia', 'GEL', '+995'),
('HK', 'Hong Kong', 'Hong Kong Special Administrative Region', 'Asia', 'HKD', '+852'),
('IN', 'India', 'Republic of India', 'Asia', 'INR', '+91'),
('ID', 'Indonesia', 'Republic of Indonesia', 'Asia', 'IDR', '+62'),
('IR', 'Iran', 'Islamic Republic of Iran', 'Asia', 'IRR', '+98'),
('IQ', 'Iraq', 'Republic of Iraq', 'Asia', 'IQD', '+964'),
('IL', 'Israel', 'State of Israel', 'Asia', 'ILS', '+972'),
('JP', 'Japan', 'Japan', 'Asia', 'JPY', '+81'),
('JO', 'Jordan', 'Hashemite Kingdom of Jordan', 'Asia', 'JOD', '+962'),
('KZ', 'Kazakhstan', 'Republic of Kazakhstan', 'Asia', 'KZT', '+7'),
('KW', 'Kuwait', 'State of Kuwait', 'Asia', 'KWD', '+965'),
('KG', 'Kyrgyzstan', 'Kyrgyz Republic', 'Asia', 'KGS', '+996'),
('LA', 'Laos', 'Lao People''s Democratic Republic', 'Asia', 'LAK', '+856'),
('LB', 'Lebanon', 'Lebanese Republic', 'Asia', 'LBP', '+961'),
('MO', 'Macau', 'Macao Special Administrative Region', 'Asia', 'MOP', '+853'),
('MY', 'Malaysia', 'Malaysia', 'Asia', 'MYR', '+60'),
('MV', 'Maldives', 'Republic of Maldives', 'Asia', 'MVR', '+960'),
('MN', 'Mongolia', 'Mongolia', 'Asia', 'MNT', '+976'),
('MM', 'Myanmar', 'Republic of the Union of Myanmar', 'Asia', 'MMK', '+95'),
('NP', 'Nepal', 'Federal Democratic Republic of Nepal', 'Asia', 'NPR', '+977'),
('KP', 'North Korea', 'Democratic People''s Republic of Korea', 'Asia', 'KPW', '+850'),
('OM', 'Oman', 'Sultanate of Oman', 'Asia', 'OMR', '+968'),
('PK', 'Pakistan', 'Islamic Republic of Pakistan', 'Asia', 'PKR', '+92'),
('PS', 'Palestine', 'State of Palestine', 'Asia', 'ILS', '+970'),
('PH', 'Philippines', 'Republic of the Philippines', 'Asia', 'PHP', '+63'),
('QA', 'Qatar', 'State of Qatar', 'Asia', 'QAR', '+974'),
('SA', 'Saudi Arabia', 'Kingdom of Saudi Arabia', 'Asia', 'SAR', '+966'),
('SG', 'Singapore', 'Republic of Singapore', 'Asia', 'SGD', '+65'),
('KR', 'South Korea', 'Republic of Korea', 'Asia', 'KRW', '+82'),
('LK', 'Sri Lanka', 'Democratic Socialist Republic of Sri Lanka', 'Asia', 'LKR', '+94'),
('SY', 'Syria', 'Syrian Arab Republic', 'Asia', 'SYP', '+963'),
('TW', 'Taiwan', 'Republic of China (Taiwan)', 'Asia', 'TWD', '+886'),
('TJ', 'Tajikistan', 'Republic of Tajikistan', 'Asia', 'TJS', '+992'),
('TH', 'Thailand', 'Kingdom of Thailand', 'Asia', 'THB', '+66'),
('TL', 'Timor-Leste', 'Democratic Republic of Timor-Leste', 'Asia', 'USD', '+670'),
('TR', 'Turkey', 'Republic of Türkiye', 'Asia', 'TRY', '+90'),
('TM', 'Turkmenistan', 'Turkmenistan', 'Asia', 'TMT', '+993'),
('AE', 'United Arab Emirates', 'United Arab Emirates', 'Asia', 'AED', '+971'),
('UZ', 'Uzbekistan', 'Republic of Uzbekistan', 'Asia', 'UZS', '+998'),
('VN', 'Vietnam', 'Socialist Republic of Viet Nam', 'Asia', 'VND', '+84'),
('YE', 'Yemen', 'Republic of Yemen', 'Asia', 'YER', '+967'),

-- Oceania
('AU', 'Australia', 'Commonwealth of Australia', 'Oceania', 'AUD', '+61'),
('FJ', 'Fiji', 'Republic of Fiji', 'Oceania', 'FJD', '+679'),
('KI', 'Kiribati', 'Republic of Kiribati', 'Oceania', 'AUD', '+686'),
('MH', 'Marshall Islands', 'Republic of the Marshall Islands', 'Oceania', 'USD', '+692'),
('FM', 'Micronesia', 'Federated States of Micronesia', 'Oceania', 'USD', '+691'),
('NR', 'Nauru', 'Republic of Nauru', 'Oceania', 'AUD', '+674'),
('NZ', 'New Zealand', 'New Zealand', 'Oceania', 'NZD', '+64'),
('PW', 'Palau', 'Republic of Palau', 'Oceania', 'USD', '+680'),
('PG', 'Papua New Guinea', 'Independent State of Papua New Guinea', 'Oceania', 'PGK', '+675'),
('WS', 'Samoa', 'Independent State of Samoa', 'Oceania', 'WST', '+685'),
('SB', 'Solomon Islands', 'Solomon Islands', 'Oceania', 'SBD', '+677'),
('TO', 'Tonga', 'Kingdom of Tonga', 'Oceania', 'TOP', '+676'),
('TV', 'Tuvalu', 'Tuvalu', 'Oceania', 'AUD', '+688'),
('VU', 'Vanuatu', 'Republic of Vanuatu', 'Oceania', 'VUV', '+678');

-- 3. Insert missing currencies into the existing currencies table
INSERT INTO public.currencies (code, name, symbol) VALUES
('AFN', 'Afghan Afghani', '؋'),
('ALL', 'Albanian Lek', 'L'),
('AMD', 'Armenian Dram', '֏'),
('AOA', 'Angolan Kwanza', 'Kz'),
('AZN', 'Azerbaijani Manat', '₼'),
('BAM', 'Bosnia-Herzegovina Convertible Mark', 'KM'),
('BBD', 'Barbadian Dollar', 'Bds$'),
('BGN', 'Bulgarian Lev', 'лв'),
('BIF', 'Burundian Franc', 'FBu'),
('BND', 'Brunei Dollar', 'B$'),
('BOB', 'Bolivian Boliviano', 'Bs.'),
('BSD', 'Bahamian Dollar', 'B$'),
('BTN', 'Bhutanese Ngultrum', 'Nu.'),
('BWP', 'Botswana Pula', 'P'),
('BYN', 'Belarusian Ruble', 'Br'),
('BZD', 'Belize Dollar', 'BZ$'),
('CDF', 'Congolese Franc', 'FC'),
('CRC', 'Costa Rican Colón', '₡'),
('CUP', 'Cuban Peso', '₱'),
('CVE', 'Cape Verdean Escudo', '$'),
('CZK', 'Czech Koruna', 'Kč'),
('DJF', 'Djiboutian Franc', 'Fdj'),
('DOP', 'Dominican Peso', 'RD$'),
('DZD', 'Algerian Dinar', 'د.ج'),
('ERN', 'Eritrean Nakfa', 'Nfk'),
('FJD', 'Fijian Dollar', 'FJ$'),
('GEL', 'Georgian Lari', '₾'),
('GMD', 'Gambian Dalasi', 'D'),
('GNF', 'Guinean Franc', 'FG'),
('GTQ', 'Guatemalan Quetzal', 'Q'),
('GYD', 'Guyanese Dollar', 'GY$'),
('HNL', 'Honduran Lempira', 'L'),
('HTG', 'Haitian Gourde', 'G'),
('HUF', 'Hungarian Forint', 'Ft'),
('IQD', 'Iraqi Dinar', 'ع.د'),
('IRR', 'Iranian Rial', '﷼'),
('ISK', 'Icelandic Króna', 'kr'),
('JMD', 'Jamaican Dollar', 'J$'),
('JOD', 'Jordanian Dinar', 'JD'),
('KGS', 'Kyrgyzstani Som', 'сом'),
('KHR', 'Cambodian Riel', '៛'),
('KMF', 'Comorian Franc', 'CF'),
('KPW', 'North Korean Won', '₩'),
('KWD', 'Kuwaiti Dinar', 'د.ك'),
('KZT', 'Kazakhstani Tenge', '₸'),
('LAK', 'Lao Kip', '₭'),
('LBP', 'Lebanese Pound', 'ل.ل'),
('LRD', 'Liberian Dollar', 'L$'),
('LSL', 'Lesotho Loti', 'L'),
('LYD', 'Libyan Dinar', 'ل.د'),
('MAD', 'Moroccan Dirham', 'MAD'),
('MDL', 'Moldovan Leu', 'L'),
('MGA', 'Malagasy Ariary', 'Ar'),
('MKD', 'Macedonian Denar', 'ден'),
('MMK', 'Myanmar Kyat', 'K'),
('MNT', 'Mongolian Tugrik', '₮'),
('MOP', 'Macanese Pataca', 'MOP$'),
('MRU', 'Mauritanian Ouguiya', 'UM'),
('MUR', 'Mauritian Rupee', '₨'),
('MVR', 'Maldivian Rufiyaa', 'Rf'),
('MWK', 'Malawian Kwacha', 'MK'),
('MZN', 'Mozambican Metical', 'MT'),
('NAD', 'Namibian Dollar', 'N$'),
('NIO', 'Nicaraguan Córdoba', 'C$'),
('NPR', 'Nepalese Rupee', '₨'),
('OMR', 'Omani Rial', 'ر.ع.'),
('PAB', 'Panamanian Balboa', 'B/.'),
('PGK', 'Papua New Guinean Kina', 'K'),
('PYG', 'Paraguayan Guarani', '₲'),
('QAR', 'Qatari Riyal', 'ر.ق'),
('RON', 'Romanian Leu', 'lei'),
('RSD', 'Serbian Dinar', 'din.'),
('SBD', 'Solomon Islands Dollar', 'SI$'),
('SCR', 'Seychellois Rupee', '₨'),
('SDG', 'Sudanese Pound', 'ج.س.'),
('SLE', 'Sierra Leonean Leone', 'Le'),
('SOS', 'Somali Shilling', 'Sh'),
('SRD', 'Surinamese Dollar', 'SR$'),
('SSP', 'South Sudanese Pound', '£'),
('STN', 'São Tomé and Príncipe Dobra', 'Db'),
('SYP', 'Syrian Pound', '£S'),
('SZL', 'Swazi Lilangeni', 'E'),
('TJS', 'Tajikistani Somoni', 'SM'),
('TMT', 'Turkmenistani Manat', 'T'),
('TND', 'Tunisian Dinar', 'د.ت'),
('TOP', 'Tongan Paʻanga', 'T$'),
('TTD', 'Trinidad and Tobago Dollar', 'TT$'),
('UAH', 'Ukrainian Hryvnia', '₴'),
('UYU', 'Uruguayan Peso', '$U'),
('UZS', 'Uzbekistani Som', 'сўм'),
('VES', 'Venezuelan Bolívar', 'Bs.S'),
('VUV', 'Vanuatu Vatu', 'VT'),
('WST', 'Samoan Tala', 'WS$'),
('XAF', 'Central African CFA Franc', 'FCFA'),
('XCD', 'East Caribbean Dollar', 'EC$'),
('XOF', 'West African CFA Franc', 'CFA'),
('YER', 'Yemeni Rial', '﷼'),
('ZMW', 'Zambian Kwacha', 'ZK'),
('ZWL', 'Zimbabwean Dollar', 'Z$'),
('BHD', 'Bahraini Dinar', 'BD'),
('LKR', 'Sri Lankan Rupee', '₨')
ON CONFLICT (code) DO NOTHING;

-- 4. Localization Packs table
CREATE TABLE public.localization_packs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  country_code TEXT NOT NULL REFERENCES public.countries(code),
  name TEXT NOT NULL,
  description TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  is_active BOOLEAN NOT NULL DEFAULT true,
  is_published BOOLEAN NOT NULL DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.localization_packs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Localization packs are publicly readable"
  ON public.localization_packs FOR SELECT
  USING (true);

-- 5. Localization Pack Tax Templates
CREATE TABLE public.localization_pack_tax_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  rate NUMERIC NOT NULL DEFAULT 0,
  description TEXT,
  tax_type TEXT DEFAULT 'percentage',
  is_compound BOOLEAN NOT NULL DEFAULT false,
  is_inclusive BOOLEAN NOT NULL DEFAULT false,
  is_default BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.localization_pack_tax_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Pack tax templates are publicly readable"
  ON public.localization_pack_tax_templates FOR SELECT
  USING (true);

-- 6. Localization Pack Account Templates (Chart of Accounts)
CREATE TABLE public.localization_pack_account_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  parent_code TEXT,
  description TEXT,
  cash_flow_category TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.localization_pack_account_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Pack account templates are publicly readable"
  ON public.localization_pack_account_templates FOR SELECT
  USING (true);

-- 7. Localization Pack Payroll Templates
CREATE TABLE public.localization_pack_payroll_templates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id) ON DELETE CASCADE,
  rule_type TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  description TEXT,
  parameters JSONB NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.localization_pack_payroll_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Pack payroll templates are publicly readable"
  ON public.localization_pack_payroll_templates FOR SELECT
  USING (true);

-- 8. Installed Localization Packs (per organization)
CREATE TABLE public.installed_localization_packs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  pack_id UUID NOT NULL REFERENCES public.localization_packs(id),
  pack_version TEXT NOT NULL,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  installed_by UUID,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE(organization_id, pack_id)
);

ALTER TABLE public.installed_localization_packs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their org installed packs"
  ON public.installed_localization_packs FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can install packs for their org"
  ON public.installed_localization_packs FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid()
    )
  );

-- Indexes
CREATE INDEX idx_localization_packs_country ON public.localization_packs(country_code);
CREATE INDEX idx_installed_packs_org ON public.installed_localization_packs(organization_id);
CREATE INDEX idx_pack_tax_templates_pack ON public.localization_pack_tax_templates(pack_id);
CREATE INDEX idx_pack_account_templates_pack ON public.localization_pack_account_templates(pack_id);
CREATE INDEX idx_pack_payroll_templates_pack ON public.localization_pack_payroll_templates(pack_id);
