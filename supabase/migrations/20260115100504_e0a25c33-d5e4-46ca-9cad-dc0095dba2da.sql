-- Add foreign key from user_roles.user_id to profiles.user_id
-- This allows PostgREST to recognize the relationship for joins
ALTER TABLE public.user_roles 
ADD CONSTRAINT user_roles_profiles_fk 
FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;