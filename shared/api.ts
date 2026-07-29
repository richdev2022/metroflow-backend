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
}

export interface InviteTeamMemberInput {
  name: string;
  email: string;
  role: "admin" | "manager" | "member";
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
  message?: string;
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
