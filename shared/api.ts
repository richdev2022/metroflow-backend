/**
 * Shared code between client and server
 * Useful to share types between client and server
 * and/or small pure JS functions that can be used on both client and server
 */

// Business Types
export interface Business {
  id: string;
  name: string;
  email: string;
  industry?: string;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

// User Types (replaces Developer)
export interface User {
  id: string;
  businessId: string;
  email: string;
  name: string;
  role: "admin" | "manager" | "member";
  status: "active" | "invited" | "inactive";
  emailVerified: boolean;
  verifiedAt?: string;
  joinedAt?: string;
  inviteToken?: string;
  inviteExpiresAt?: string;
  lastLogin?: string;
  createdAt: string;
  updatedAt: string;
}

// Team Member types (formerly Developer)
export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: "admin" | "manager" | "member";
  status: "active" | "invited" | "inactive";
  joinedAt?: string;
  /** custom role assignment (Role & Permission management) */
  roleId?: string | null;
  roleName?: string | null;
  /** resolved permission slugs for this member; owner/admin get the full catalog */
  permissions?: string[];
  /** complete employee information (invite form) */
  phoneNumber?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  employmentType?: string | null;
}

export interface InviteTeamMemberInput {
  name: string;
  email: string;
  role: "admin" | "manager" | "member";
  /** optional custom role (team_roles.id) — takes precedence for permissions */
  roleId?: string | null;
  /** complete employee information */
  phone_number?: string | null;
  phoneNumber?: string | null;
  job_title?: string | null;
  jobTitle?: string | null;
  department?: string | null;
  employment_type?: string | null;
  employmentType?: string | null;
}

// Task Status Types
export interface TaskStatus {
  id: string;
  businessId: string;
  name: string;
  color?: string;
  isDefault: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Task Types
export interface Task {
  id: string;
  businessId: string;
  createdBy: string;
  title: string;
  description?: string;
  epic?: string;
  epicId?: string;
  sprint?: string;
  targetValue: number;
  accomplishedValue: number;
  startDate: string;
  endDate: string;
  dueDate?: string;
  status: string;
  isOverdue: boolean;
  assignedTo?: string[];
  attachments?: Attachment[];
  comments?: Comment[];
  images?: string[]; // Array of image URLs
  createdAt: string;
  updatedAt: string;
}

// Attachment Types
export interface Attachment {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  fileUrl: string;
  isImage: boolean;
  uploadedBy: string;
  createdAt: string;
}

// Epic Types
export interface Epic {
  id: string;
  businessId: string;
  name: string;
  description?: string;
  status: "active" | "completed" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface Reaction {
  userId: string;
  userName?: string;
  type: "like" | "love" | "laugh";
}

// Idea Types
export interface Idea {
  id: string;
  businessId: string;
  userId: string;
  userName?: string; // Populated from join
  title: string;
  description: string;
  status: "under_review" | "executed" | "rejected";
  createdAt: string;
  updatedAt: string;
}

export interface CreateIdeaInput {
  title: string;
  description: string;
}

export interface UpdateIdeaStatusInput {
  status: "under_review" | "executed" | "rejected";
}

// Product Documentation Types
export interface ProductDocumentation {
  id: string;
  businessId: string;
  ideaId: string;
  title: string;
  content: string;
  logoUrl?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerateDocumentationInput {
  ideaId: string;
}

export interface RegenerateDocumentationInput {
  areasOfConcern: string;
}

export interface UpdateDocumentationInput {
  content?: string;
  logoUrl?: string;
}

// Comment Types with threading
export interface Comment {
  id: string;
  taskId?: string;
  epicName?: string;
  epicId?: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  parentCommentId?: string;
  content: string;
  mentions: Array<{ type: "user" | "task"; id: string }>;
  replies?: Comment[];
  reactions?: Reaction[];
  createdAt: string;
  updatedAt: string;
}

// Task Assignment
export interface TaskAssignment {
  id: string;
  taskId: string;
  userId: string;
  assignedBy: string;
  assignedAt: string;
}

// KPI Dashboard Types
export interface KPISummary {
  current: {
    total: number;
    completed: number;
    percentageCompletion: number;
  };
  monthly: {
    total: number;
    completed: number;
    percentageCompletion: number;
    targetVsAccomplishment: {
      target: number;
      accomplished: number;
    };
  };
  epics?: Record<string, {
    total: number;
    completed: number;
    percentageCompletion: number;
    startDate?: string;
    endDate?: string;
    assignedTo?: string[];
  }>;
  overdueTasks: Task[];
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// Authentication Types
export interface RegisterBusinessInput {
  businessName: string;
  businessEmail: string;
  businessIndustry?: string;
  adminName: string;
  adminEmail: string;
  password: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface OTPVerificationInput {
  email: string;
  otpCode: string;
}

export interface ResendOTPInput {
  email: string;
}

export interface ForgotPasswordInput {
  email: string;
}

export interface VerifyResetOTPInput {
  email: string;
  otpCode: string;
}

export interface ResetPasswordInput {
  email: string;
  otpCode: string;
  newPassword: string;
}

export interface AuthResponse {
  success: boolean;
  userId?: string;
  businessId?: string;
  token?: string;
  requiresOtp?: boolean;
  /** Authenticated user's display name — clients greet the user by NAME,
   *  regardless of whether they logged in with password, OTP or Google. */
  name?: string;
  email?: string;
  message?: string;
  /** Legacy workspace role string: owner | admin | manager | member. */
  role?: string;
  /** True for owner/admin — only these may edit the BUSINESS profile. */
  isBusinessAdmin?: boolean;
  /** Invited (non-admin) users must complete their PERSONAL profile once. */
  requiresProfileCompletion?: boolean;
  profileCompleted?: boolean;
  phoneVerified?: boolean;
  profilePromptDismissed?: boolean;
  avatarUrl?: string;
  phoneNumber?: string;
}

// ---------- Google SSO ----------
export interface GoogleAuthInput {
  /** Google ID token issued by Google Identity Services */
  credential: string;
  businessName?: string;
  businessIndustry?: string;
}

export interface GoogleAuthUser {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string | null;
  authProvider: string;
  hasPassword: boolean;
}

export interface GoogleAuthResponse extends AuthResponse {
  isNewUser?: boolean;
  /** True when the account has no password yet (SSO-only) and should be prompted to create one */
  requiresPasswordSetup?: boolean;
  user?: GoogleAuthUser;
  business?: { id: string; name: string; email: string };
}

export interface SetPasswordInput {
  password: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface MeResponse {
  id: string;
  businessId: string;
  email: string;
  name: string;
  role: string;
  avatarUrl?: string | null;
  authProvider: string;
  hasPassword: boolean;
  emailVerified: boolean;
  kycStatus: string;
  phoneNumber?: string | null;
}

// Task Creation with new fields
export interface CreateTaskInput {
  title: string;
  description?: string;
  epic?: string;
  epicId?: string;
  sprint?: string;
  startDate?: string;
  endDate?: string;
  dueDate?: string;
  assignedTo?: string[];
  images?: string[]; // Array of image URLs or base64 data
}

// Bulk Task Creation from Excel
export interface BulkTaskInput {
  tasks: CreateTaskInput[];
}

// User Invitation
export interface InviteUserInput {
  name: string;
  email: string;
  role: "admin" | "manager" | "developer";
}

// Legacy Developer invitation (for backward compatibility)
export interface InviteDeveloperInput {
  name: string;
  email: string;
  role: "admin" | "manager" | "developer";
}

// Comment Creation
export interface CreateCommentInput {
  taskId?: string;
  epicName?: string;
  epicId?: string;
  content: string;
  parentCommentId?: string;
  mentions?: Array<{ type: "user" | "task"; id: string }>;
}

// Task Assignment
export interface AssignTaskInput {
  taskIds: string[];
  userIds: string[];
}

// Epic Counts for pagination fix
export interface EpicCounts {
  [epic: string]: number;
}

export interface DemoResponse {
  message: string;
}

// Transaction PIN types
export interface CreateTransactionPinInput {
  pin: string;
}

export interface VerifyTransactionPinInput {
  pin: string;
}

export interface UpdateTransactionPinInput {
  oldPin: string;
  newPin: string;
}

// OTP toggle types
export interface ToggleOtpInput {
  enabled: boolean;
}

// Updated transfer input types with PIN and optional OTP
export interface InitiateSingleTransferInput {
  bankCode: string;
  accountNumber: string;
  accountName?: string;
  amount: number;
  remark?: string;
  otp?: string;
  pin: string;
  walletId?: string;
}

export interface AddParticipantsInput {
  participantIds: string[];
}

export interface AddParticipantsResponse {
  success: boolean;
  message: string;
  data: {
    added: string[];
  };
  error?: string;
}

export interface InitiateBulkTransferInput {
  type: 'Salary' | 'Epic';
  otp?: string;
  pin: string;
  sourceWalletId?: string;
  data?: {
    items?: Array<{
      amount: number;
      bankCode: string;
      accountNumber: string;
      accountName?: string;
      remark?: string;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Customer Support desk (MetricAi human handoff) Types
// ---------------------------------------------------------------------------

export type SupportConversationStatus = "open" | "pending" | "resolved" | "closed";
export type SupportSenderType = "customer" | "agent" | "system" | "ai";
export type SupportChannel = "metric_ai" | "webapp_widget" | "website_widget" | "mobile";

export interface SupportMessage {
  id: string;
  conversation_id: string;
  sender_type: SupportSenderType;
  sender_id?: string | null;
  sender_name?: string | null;
  body: string;
  meta?: Record<string, any> | null;
  created_at: string;
}

export interface SupportConversation {
  id: string;
  business_id?: string | null;
  user_id?: string | null;
  guest_name?: string | null;
  guest_email?: string | null;
  channel?: SupportChannel;
  subject?: string | null;
  status: SupportConversationStatus;
  assigned_agent_id?: string | null;
  assigned_agent_name?: string | null;
  last_message_at: string;
  last_message_preview?: string | null;
  unread_for_agent?: number;
  unread_for_customer?: number;
  user_name?: string | null;
  user_email?: string | null;
  business_name?: string | null;
  message_count?: number;
  created_at: string;
  updated_at: string;
}

export interface EscalateSupportInput {
  name: string;
  email: string;
  subject?: string;
  message?: string;
  channel?: SupportChannel;
  transcript?: Array<{ role: "user" | "assistant"; content: string; createdAt?: string }>;
}

export interface AiActivityRow {
  id: string;
  content?: string | null;
  image_url?: string | null;
  created_at: string;
  user_name?: string | null;
  user_email?: string | null;
  business_name?: string | null;
}

export interface AdminNotification {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  conversation_id?: string | null;
  is_read: boolean;
  created_at: string;
}
