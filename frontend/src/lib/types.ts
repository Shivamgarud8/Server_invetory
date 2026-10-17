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

export type IpType = "private" | "public" | "vpn" | "network" | "management";
export interface Network { id?: number; ip_type: IpType; ip_address: string; label: string | null }
export type Health = "healthy" | "warning" | "critical" | "offline" | "unknown";
export interface ClientBrief { id: number; name: string; color: string }
export interface Spec { cpu_cores: number | null; ram_gb: number | null; disk_gb: number | null; disk_usage_pct: number | null }

export interface Server {
  id: number;
  name: string;
  hostname: string | null;
  environment: Environment;
  client: ClientBrief | null;
  server_type: string;
  role: string;
  ssh_user: string | null;
  ssh_port: number | null;
  ssh_auth_method: string | null;
  ssh_key_ref: string | null;
  mount_points: string | null;
  exposed_ports: string | null;
  firewall_notes: string | null;
  backup_policy: string | null;
  recovery_instructions: string | null;
  health_status: Health;
  health_detail: string | null;
  health_checked_at: string | null;
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
  client: ClientBrief | null;
  linked_service: { id: number; label: string } | null;
  rotation_policy: "static" | "periodic";
  rotation_interval_days: number | null;
  next_rotation_at: string | null;
  pending_verification: boolean;
  last_change_reason: string | null;
  history_count: number;
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
  service_type: string;
  port: number | null;
  protocol: string | null;
  health_url: string | null;
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

export interface Client {
  id: number;
  name: string;
  code: string | null;
  description: string | null;
  architecture_type: "single" | "three_tier" | "shared_db" | "custom";
  color: string;
  contact: string | null;
  notes: string | null;
  runbook: string | null;
  backup_policy: string | null;
  recovery_plan: string | null;
  created_at: string;
  updated_at: string;
  server_count: number;
  service_count: number;
  domain_count: number;
  credential_count: number;
  environments: string[];
  health: Record<string, number>;
}

export interface Domain {
  id: number;
  name: string;
  client: ClientBrief | null;
  environment: Environment | null;
  server: { id: number; name: string } | null;
  record_type: string;
  target: string | null;
  dns_provider: string | null;
  ssl_provider: string | null;
  ssl_expires_at: string | null;
  purpose: string | null;
  notes: string | null;
  health_status: Health;
  health_detail: string | null;
  health_checked_at: string | null;
}

export interface Dependency { id: number; from_service_id: number; to_service_id: number; protocol: string | null; port: number | null; label: string | null }
export interface PasswordHistoryEntry { id: number; valid_from: string | null; replaced_at: string; replaced_by: string | null; reason: string | null }
