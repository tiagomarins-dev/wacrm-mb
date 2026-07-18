-- ============================================================
-- 073: data da prova na ficha do curso (ai_courses). O tool get_curso
-- computa "semanas restantes até a prova" — assim o nº de correções
-- semanais informado pela IA fica sempre atual (era texto estático
-- "aprox. 20 correções" na ficha do Método Blindado Intensivo).
-- ============================================================
alter table ai_courses add column if not exists data_prova date;

-- Seed: Intensivo ENEM (prova 08/11/2026) + entregas sem o número estático
update ai_courses set data_prova = '2026-11-08' where slug = 'metodo-blindado-intensivo';
update ai_courses
   set entregas = replace(entregas,
     'cerca de uma correção por semana (aprox. 20 correções)',
     'uma correção por semana, da matrícula até o ENEM (08/11/2026)')
 where slug = 'metodo-blindado-intensivo' and entregas like '%aprox. 20 correções%';
