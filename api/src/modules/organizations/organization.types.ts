export interface Organization {
  id: string;
  name: string;
  plan_tier: string;
  api_key_hash: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CreateOrganizationDTO {
  name: string;
  plan_tier?: string;
}

export interface UpdateOrganizationDTO {
  name?: string;
  plan_tier?: string;
  api_key_hash?: string | null;
  is_active?: boolean;
}
