CREATE OR REPLACE FUNCTION public.gs1_ai_table()
RETURNS TABLE(ai text, name text, fixed int, max_len int, decimal_indicator boolean)
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT * FROM (VALUES
    ('00','sscc',18,NULL,false),
    ('01','gtin',14,NULL,false),
    ('02','gtinContained',14,NULL,false),
    ('10','lot',NULL,20,false),
    ('11','productionDate',6,NULL,false),
    ('13','packagingDate',6,NULL,false),
    ('15','bestBefore',6,NULL,false),
    ('17','expiry',6,NULL,false),
    ('20','variant',2,NULL,false),
    ('21','serial',NULL,20,false),
    ('30','count',NULL,8,false),
    ('37','countOfUnits',NULL,8,false),
    ('240','additionalItemId',NULL,30,false),
    ('241','customerPart',NULL,30,false),
    ('414','gln',13,NULL,false),
    ('310','netWeightKg',6,NULL,true),
    ('311','lengthM',6,NULL,true),
    ('312','widthM',6,NULL,true),
    ('313','depthM',6,NULL,true),
    ('314','areaM2',6,NULL,true),
    ('315','netVolumeL',6,NULL,true),
    ('316','netVolumeM3',6,NULL,true)
  ) AS t(ai, name, fixed, max_len, decimal_indicator);
$$;
