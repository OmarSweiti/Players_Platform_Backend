import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { PERMISSIONS, PermissionType } from '../../../../shared/constants/permissions.constants';

@Injectable()
export class PermissionService {
  constructor(private prisma: PrismaService) {}

  /**
   * Check if a user role has a specific permission
   */
  async hasPermission(role: UserRole, permission: PermissionType): Promise<boolean> {
    const permissionRecord = await this.prisma.permission.findUnique({
      where: { name: permission },
      include: {
        roles: {
          where: { roleId: role },
        },
      },
    });

    return !!permissionRecord && permissionRecord.roles.length > 0;
  }

  /**
   * Get all permissions for a role
   */
  async getRolePermissions(role: UserRole): Promise<string[]> {
    const rolePermissions = await this.prisma.rolePermission.findMany({
      where: { roleId: role },
      include: { permission: true },
    });

    return rolePermissions.map(rp => rp.permission.name);
  }

  /**
   * Seed default permissions for all roles
   */
  async seedDefaultPermissions(): Promise<void> {
    // Create all permission records
    const permissionValues = Object.values(PERMISSIONS);
    
    for (const permName of permissionValues) {
      const [category, action] = permName.split('.');
      
      await this.prisma.permission.upsert({
        where: { name: permName },
        update: {},
        create: {
          name: permName,
          category: category.toUpperCase() as any,
          action: action.toUpperCase() as any,
          description: `${action} ${category}`,
        },
      });
    }

    // Assign default permissions to each role
    const rolePermissionMap = this.getDefaultRolePermissions();
    
    for (const [role, permissions] of Object.entries(rolePermissionMap)) {
      for (const permName of permissions) {
        const permission = await this.prisma.permission.findUnique({
          where: { name: permName },
        });

        if (permission) {
          await this.prisma.rolePermission.upsert({
            where: {
              roleId_permissionId: {
                roleId: role as UserRole,
                permissionId: permission.id,
              },
            },
            update: {},
            create: {
              roleId: role as UserRole,
              permissionId: permission.id,
            },
          });
        }
      }
    }
  }

  /**
   * Define default permissions for each role
   */
  private getDefaultRolePermissions(): Record<string, string[]> {
    return {
      SUPER_ADMIN: Object.values(PERMISSIONS), // All permissions
      
      OWNER: [
        PERMISSIONS.PLAYER_CREATE, PERMISSIONS.PLAYER_READ, PERMISSIONS.PLAYER_UPDATE,
        PERMISSIONS.CONTRACT_CREATE, PERMISSIONS.CONTRACT_READ, PERMISSIONS.CONTRACT_APPROVE,
        PERMISSIONS.TRAINING_READ,
        PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_VIEW_CONFIDENTIAL,
        PERMISSIONS.SCOUTING_READ,
        PERMISSIONS.MATCH_READ,
        PERMISSIONS.FINANCE_READ, PERMISSIONS.FINANCE_EXPORT,
        PERMISSIONS.LEGAL_READ,
        PERMISSIONS.USER_READ,
        PERMISSIONS.TENANT_MANAGE,
        PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_EXPORT,
        PERMISSIONS.CHAT_READ,
      ],
      
      ADMIN: [
        PERMISSIONS.PLAYER_CREATE, PERMISSIONS.PLAYER_READ, PERMISSIONS.PLAYER_UPDATE,
        PERMISSIONS.CONTRACT_CREATE, PERMISSIONS.CONTRACT_READ,
        PERMISSIONS.TRAINING_CREATE, PERMISSIONS.TRAINING_READ, PERMISSIONS.TRAINING_UPDATE,
        PERMISSIONS.MEDICAL_READ,
        PERMISSIONS.SCOUTING_READ,
        PERMISSIONS.MATCH_READ,
        PERMISSIONS.LEGAL_CREATE, PERMISSIONS.LEGAL_READ,
        PERMISSIONS.USER_CREATE, PERMISSIONS.USER_READ, PERMISSIONS.USER_UPDATE,
        PERMISSIONS.REPORT_VIEW,
        PERMISSIONS.DOCUMENT_UPLOAD,
        PERMISSIONS.CHAT_SEND, PERMISSIONS.CHAT_READ,
      ],
      
      SPORTING_DIRECTOR: [
        PERMISSIONS.PLAYER_READ, PERMISSIONS.PLAYER_UPDATE,
        PERMISSIONS.CONTRACT_READ, PERMISSIONS.CONTRACT_APPROVE,
        PERMISSIONS.SCOUTING_CREATE, PERMISSIONS.SCOUTING_READ, PERMISSIONS.SCOUTING_UPDATE,
        // Scouting Reports
        PERMISSIONS.SREPORT_CREATE, PERMISSIONS.SREPORT_READ, PERMISSIONS.SREPORT_UPDATE, PERMISSIONS.SREPORT_DELETE,
        PERMISSIONS.SREPORT_SUBMIT, PERMISSIONS.SREPORT_APPROVE, PERMISSIONS.SREPORT_REJECT,
        // Watchlist
        PERMISSIONS.WATCHLIST_VIEW, PERMISSIONS.WATCHLIST_MANAGE,
        // Assignments
        PERMISSIONS.ASSIGNMENT_VIEW, PERMISSIONS.ASSIGNMENT_MANAGE, PERMISSIONS.ASSIGNMENT_UPDATE,
        PERMISSIONS.MATCH_READ,
        PERMISSIONS.TRAINING_READ,
        PERMISSIONS.PERFORMANCE_READ,
        PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_EXPORT,
      ],
      
      COACH: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.TRAINING_CREATE, PERMISSIONS.TRAINING_READ, PERMISSIONS.TRAINING_UPDATE,
        PERMISSIONS.MATCH_READ, PERMISSIONS.MATCH_UPDATE,
        PERMISSIONS.PERFORMANCE_READ,
        PERMISSIONS.CHAT_SEND, PERMISSIONS.CHAT_READ,
      ],
      
      ASSISTANT_COACH: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.TRAINING_READ, PERMISSIONS.TRAINING_UPDATE,
        PERMISSIONS.MATCH_READ,
      ],
      
      GOALKEEPER_COACH: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.TRAINING_CREATE, PERMISSIONS.TRAINING_READ,
      ],
      
      FITNESS_COACH: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.TRAINING_CREATE, PERMISSIONS.TRAINING_READ,
        PERMISSIONS.MEDICAL_READ,
      ],
      
      SCOUT: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.SCOUTING_CREATE, PERMISSIONS.SCOUTING_READ, PERMISSIONS.SCOUTING_UPDATE,
        // Scouting Reports
        PERMISSIONS.SREPORT_CREATE, PERMISSIONS.SREPORT_READ, PERMISSIONS.SREPORT_UPDATE,
        PERMISSIONS.SREPORT_SUBMIT,
        // Watchlist
        PERMISSIONS.WATCHLIST_VIEW, PERMISSIONS.WATCHLIST_MANAGE,
        // Assignments
        PERMISSIONS.ASSIGNMENT_VIEW, PERMISSIONS.ASSIGNMENT_UPDATE,
        PERMISSIONS.DOCUMENT_UPLOAD,
      ],
      
      MEDICAL: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.MEDICAL_CREATE, PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_UPDATE,
        PERMISSIONS.MEDICAL_VIEW_CONFIDENTIAL,
        PERMISSIONS.TRAINING_READ,
      ],
      
      PHYSIOTHERAPIST: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.MEDICAL_CREATE, PERMISSIONS.MEDICAL_READ, PERMISSIONS.MEDICAL_UPDATE,
      ],
      
      LEGAL: [
        PERMISSIONS.CONTRACT_READ, PERMISSIONS.CONTRACT_APPROVE,
        PERMISSIONS.LEGAL_CREATE, PERMISSIONS.LEGAL_READ, PERMISSIONS.LEGAL_UPDATE, PERMISSIONS.LEGAL_APPROVE,
        PERMISSIONS.DOCUMENT_UPLOAD,
      ],
      
      FINANCE_MANAGER: [
        PERMISSIONS.CONTRACT_READ,
        PERMISSIONS.FINANCE_READ, PERMISSIONS.FINANCE_MANAGE, PERMISSIONS.FINANCE_EXPORT,
        PERMISSIONS.REPORT_VIEW,
      ],
      
      PERFORMANCE_ANALYST: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.MATCH_READ,
        PERMISSIONS.PERFORMANCE_CREATE, PERMISSIONS.PERFORMANCE_READ,
        PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_EXPORT,
      ],
      
      VIDEO_ANALYST: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.MATCH_READ,
        PERMISSIONS.DOCUMENT_UPLOAD,
        PERMISSIONS.REPORT_VIEW,
      ],
      
      TRAINING_MANAGER: [
        PERMISSIONS.PLAYER_READ,
        PERMISSIONS.TRAINING_CREATE, PERMISSIONS.TRAINING_READ, PERMISSIONS.TRAINING_UPDATE, PERMISSIONS.TRAINING_DELETE,
        PERMISSIONS.TRAINING_ASSIGN,
      ],
      
      PLAYER: [
        PERMISSIONS.PLAYER_READ, // Own profile only (handled in service)
        PERMISSIONS.CONTRACT_READ, // Own contracts only
        PERMISSIONS.TRAINING_READ, // Assigned trainings
        PERMISSIONS.MEDICAL_READ, // Own medical only
        PERMISSIONS.CHAT_SEND, PERMISSIONS.CHAT_READ,
      ],
      
      GUARDIAN: [
        PERMISSIONS.PLAYER_READ, // Linked players only
        PERMISSIONS.TRAINING_READ,
      ],
    };
  }
}
