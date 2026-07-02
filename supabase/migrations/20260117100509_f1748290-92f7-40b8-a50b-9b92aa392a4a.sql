-- Fix set_manager_pin function to include extensions schema for pgcrypto
CREATE OR REPLACE FUNCTION public.set_manager_pin(p_organization_id uuid, p_user_id uuid, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    INSERT INTO public.pos_manager_pins (organization_id, user_id, pin_hash)
    VALUES (p_organization_id, p_user_id, crypt(p_pin, gen_salt('bf')))
    ON CONFLICT (organization_id, user_id) 
    DO UPDATE SET 
        pin_hash = crypt(p_pin, gen_salt('bf')),
        updated_at = now();
    
    RETURN TRUE;
END;
$function$;

-- Fix set_cashier_pin function to include extensions schema for pgcrypto
CREATE OR REPLACE FUNCTION public.set_cashier_pin(p_cashier_id uuid, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
BEGIN
    UPDATE public.pos_cashiers 
    SET 
        pin_hash = crypt(p_pin, gen_salt('bf')),
        updated_at = now()
    WHERE id = p_cashier_id;
    
    RETURN FOUND;
END;
$function$;

-- Fix verify_manager_pin function to include extensions schema for pgcrypto
CREATE OR REPLACE FUNCTION public.verify_manager_pin(p_organization_id uuid, p_manager_id uuid, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_pin_hash TEXT;
    v_is_active BOOLEAN;
    v_has_role BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.user_roles 
        WHERE user_id = p_manager_id 
        AND role IN ('owner', 'admin', 'super_admin')
    ) INTO v_has_role;
    
    IF NOT v_has_role THEN
        RETURN FALSE;
    END IF;
    
    SELECT pin_hash, is_active 
    INTO v_pin_hash, v_is_active
    FROM public.pos_manager_pins 
    WHERE organization_id = p_organization_id 
    AND user_id = p_manager_id;
    
    IF NOT FOUND OR NOT v_is_active THEN
        RETURN FALSE;
    END IF;
    
    RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$function$;

-- Fix verify_cashier_pin function to include extensions schema for pgcrypto
CREATE OR REPLACE FUNCTION public.verify_cashier_pin(p_cashier_id uuid, p_pin text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
    v_pin_hash TEXT;
    v_is_active BOOLEAN;
BEGIN
    SELECT pin_hash, is_active 
    INTO v_pin_hash, v_is_active
    FROM public.pos_cashiers 
    WHERE id = p_cashier_id;
    
    IF NOT FOUND OR NOT v_is_active THEN
        RETURN FALSE;
    END IF;
    
    RETURN v_pin_hash = crypt(p_pin, v_pin_hash);
END;
$function$;