-- Hide Master Inventory items that are not on the official stock list
-- (FLYSCREEN STOCK OCT 14.xlsx, STOCK sheet; user's request 2026-10-30,
-- "Hide them", "Keep the 21 newer items"). Applied live 2026-10-30.
--
-- Nothing is deleted: the rows and their history stay. Only status changes,
-- and only for rows with no stock (all 21 had stock 0 / value 0, so the
-- Stock Value stayed AED 811,982.52). The site hides a row when
-- status = 'inactive' AND current_qty = 0, so one that gets stock again
-- (a Check-in) shows up again by itself.
--
-- Kept on purpose although not on the Oct 14 list: the L Angle / Box Section /
-- Flat Trim items added 21-27 Oct (10001-*, 10002-*, 10003-*, "15x40 Box
-- Section"), and "Pet Mesh" (= "PET MESH" on the list, which has no code).
update public.inventory_items set status = 'inactive'
where item_code in ('15X30', '190003', '190004', '20X40', '210019', '210055',
  '230045', '230046', '230047', '230048', '230049', '230050', '230051',
  '230053', '230054', '230055', '290001', '30017', '320002', '320003', '910002R')
  and current_qty = 0;

-- Show one (or all) again:
--   update public.inventory_items set status = 'active' where item_code = '<code>';
--   update public.inventory_items set status = 'active' where status = 'inactive';
