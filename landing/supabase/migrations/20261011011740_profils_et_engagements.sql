-- PubResearcher — page d'accueil : profils professionnels et engagements d'anonymisation.
--
-- À exécuter une fois, dans l'éditeur SQL de Supabase (ou avec `supabase db push`).
-- AUCUNE donnée de patient ne passe par ces tables : seulement le profil professionnel de l'utilisateur
-- et la trace de l'engagement qu'il a pris (quelle version de la charte, à quel moment).
--
-- Sécurité : la clé publique du site est lisible par tout visiteur, par conception. Ce qui protège les données,
-- ce sont les règles d'accès par ligne ci-dessous : chacun ne lit et n'écrit que ses propres lignes, et personne
-- — pas même son titulaire — ne modifie ni n'efface une ligne d'engagement.

-- ---------------------------------------------------------------------------------------------------------------
-- Profils : une ligne par utilisateur, créée ou mise à jour pendant le parcours d'accueil.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 120),
  role text not null check (role in ('interne', 'medecin', 'chercheur', 'doctorant', 'arc', 'autre')),
  institution text not null check (char_length(institution) between 2 and 160),
  country text not null check (char_length(country) between 2 and 80),
  specialty text check (specialty is null or char_length(specialty) <= 120),
  study_type text check (study_type is null or study_type in ('retro-mono', 'retro-multi', 'these', 'revue', 'essai', 'autre')),
  volume text check (volume is null or volume in ('lt100', '100-1000', 'gt1000', 'inconnu')),
  hosting text check (hosting is null or hosting in ('poste', 'etablissement', 'inconnu')),
  ethics text check (ethics is null or ethics in ('obtenue', 'en-cours', 'pas-encore', 'sans-objet')),
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is 'Profil professionnel saisi pendant le parcours d''accueil de PubResearcher. Aucune donnée de patient.';

-- ---------------------------------------------------------------------------------------------------------------
-- Engagements : une ligne par confirmation de la charte d'anonymisation. Journal en ajout seul.
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('anonymisation')),
  -- Version du texte confirmé (voir ANONYMISATION_VERSION dans landing/src/lib/charter.ts).
  version text not null check (char_length(version) between 1 and 40),
  -- Identifiants des engagements cochés (CHARTER_ITEMS), tels que le site les envoie : une trace déclarative — la base
  -- vérifie leur forme, pas leur contenu, ni que la case a été cochée par une personne.
  items text[] not null check (cardinality(items) between 1 and 20),
  accepted_at timestamptz not null default now()
);

create index if not exists consents_user_kind_idx on public.consents (user_id, kind, accepted_at desc);

comment on table public.consents is 'Engagements d''anonymisation confirmés (journal en ajout seul : ni modification ni suppression).';

-- ---------------------------------------------------------------------------------------------------------------
-- Date de dernière modification du profil.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- Règles d'accès par ligne.
-- ---------------------------------------------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.consents enable row level security;

drop policy if exists "profil : lecture par son titulaire" on public.profiles;
create policy "profil : lecture par son titulaire"
  on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "profil : création par son titulaire" on public.profiles;
create policy "profil : création par son titulaire"
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "profil : mise à jour par son titulaire" on public.profiles;
create policy "profil : mise à jour par son titulaire"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "engagement : lecture par son titulaire" on public.consents;
create policy "engagement : lecture par son titulaire"
  on public.consents for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "engagement : création par son titulaire" on public.consents;
create policy "engagement : création par son titulaire"
  on public.consents for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------------------------------------------
-- Droits : exactement ce dont le site a besoin, colonne par colonne.
-- ---------------------------------------------------------------------------------------------------------------
-- On part de zéro (Supabase accorde d'office tous les droits aux rôles `anon` et `authenticated` sur les tables du
-- schéma public), puis on rend à l'utilisateur connecté le strict nécessaire :
--  - un visiteur non connecté (`anon`) n'a rien ;
--  - personne ne supprime son profil (il disparaît avec son compte), ni ne modifie ou n'efface un engagement ;
--  - les dates `created_at`, `updated_at`, `accepted_at` et l'identifiant d'un engagement sont posés par la base,
--    jamais par le navigateur : un engagement ne peut pas être antidaté.
revoke all on public.profiles from anon, authenticated;
revoke all on public.consents from anon, authenticated;

grant select on public.profiles to authenticated;
grant insert (user_id, full_name, role, institution, country, specialty, study_type, volume, hosting, ethics, onboarding_completed_at)
  on public.profiles to authenticated;
-- L'enregistrement du profil est un « upsert » : en cas de conflit, PostgREST réécrit toutes les colonnes envoyées,
-- `user_id` compris (même valeur ; la règle d'accès interdit d'en changer).
grant update (user_id, full_name, role, institution, country, specialty, study_type, volume, hosting, ethics, onboarding_completed_at)
  on public.profiles to authenticated;

grant select on public.consents to authenticated;
grant insert (user_id, kind, version, items) on public.consents to authenticated;
