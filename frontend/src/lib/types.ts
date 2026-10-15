export interface Environment { id: number; name: string; color: string; sort_order: number; is_production: boolean }
export interface Tag { id: number; name: string; color: string }
export interface CredentialType { id: number; name: string; default_port: number | null }

export interface Me {
  id: number;
  username: string;
  full_name: string;
  email: string | null;
  roles: string[];
  permissions: string[];
  all_environments: boolean;
  environments: Environment[];
  totp_enabled: boolean;
  must_change_password: boolean;
  session_idle_minutes: number;
  vault_provider: string;
}

export interface Network { id?: number; ip_type: "private" | "public" | "network" | "management"; ip_address: string; label: string | null }
export interface Spec { cpu_cores: number | null; ram_gb: number | null; disk_gb: number | null; disk_usage_pct: number | null }

export interface Server {
  id: number;
  name: string;
  hostname: string | null;
  environment: Environment;
  server_type: string;
  provider: string | null;
  location: string | null;
  os_name: string | null;
  os_version: string | null;
  kernel_version: string | null;
  architecture: string | null;
  docker_version: string | null;
  compose_version: string | null;
  status: string;
  owner: string | null;
  purpose: string | null;
  notes: string | null;
  spec: Spec | null;
  networks: Network[];
  tags: Tag[];
  created_at: string;
  updated_at: string;
  credential_count: number;
  deployment_count: number;
}

export interface Credential {
  id: number;
  name: string;
  credential_type: CredentialType;
  category: string | null;
  server: { id: number; name: string } | null;
  environment: Environment;
  host: string | null;
  port: number | null;
  username: string | null;
  url: string | null;
  service: string | null;
  description: string | null;
  owner: string | null;
  status: string;
  notes: string | null;
  has_secret: boolean;
  secret_provider: string;
  password_changed_at: string | null;
  expires_at: string | null;
  tags: Tag[];
  created_at: string;
  updated_at: string;
}

export interface Application { id: number; name: string; category: string | null; description: string | null; repository_url: string | null; deployment_count: number }

export interface Deployment {
  id: number;
  application: Application;
  component: string;
  server: { id: number; name: string } | null;
  environment: Environment;
  current_version: string;
  previous_version: string | null;
  image: string | null;
  deployed_at: string;
  updated_by_name: string | null;
  notes: string | null;
}

export interface History {
  id: number;
  application_version_id: number | null;
  application_name: string;
  component: string;
  server_name: string | null;
  environment_name: string;
  old_version: string | null;
  new_version: string;
  changed_by: string | null;
  changed_at: string;
  notes: string | null;
}

export interface Permission { id: number; code: string; module: string; action: string; description: string }
export interface Role { id: number; name: string; description: string; is_system: boolean; permissions: string[]; user_count: number }
export interface Override { code: string; granted: boolean }

export interface User {
  id: number;
  username: string;
  email: string | null;
  full_name: string;
  is_active: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
  locked: boolean;
  last_login_at: string | null;
  last_login_ip: string | null;
  created_at: string;
  roles: Role[];
  role_ids: number[];
  overrides: Override[];
  all_environments: boolean;
  environment_ids: number[];
  effective_permissions: string[];
}

export interface SessionInfo { id: number; user_id: number; username: string; created_at: string; last_seen_at: string; expires_at: string; ip_address: string | null; user_agent: string | null; current: boolean }

export interface AuditEntry { id: number; created_at: string; username: string | null; action: string; entity_type: string | null; entity_id: number | null; entity_label: string | null; ip_address: string | null; user_agent: string | null; details: Record<string, unknown> | null }
