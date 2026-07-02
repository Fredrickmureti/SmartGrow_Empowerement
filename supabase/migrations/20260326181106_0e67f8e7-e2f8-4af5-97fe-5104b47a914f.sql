-- Add salary_structure_id to employee_contracts so payroll engine can resolve component-based compensation
ALTER TABLE employee_contracts 
ADD COLUMN IF NOT EXISTS salary_structure_id uuid REFERENCES salary_structures(id) ON DELETE SET NULL;

-- Create index for efficient lookup
CREATE INDEX IF NOT EXISTS idx_employee_contracts_salary_structure_id 
ON employee_contracts(salary_structure_id) WHERE salary_structure_id IS NOT NULL;