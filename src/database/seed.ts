import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PermissionService } from '../modules/users/application/services/permission.service';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { UserRole } from '@prisma/client';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const permissionService = app.get(PermissionService);
  const prisma = app.get(PrismaService);

  console.log('=== Starting Database Seeding ===\n');

  // Step 1: Seed permissions
  console.log('Step 1: Seeding permissions...');
  await permissionService.seedDefaultPermissions();
  console.log('✓ Permissions seeded successfully!\n');

  // Step 2: Create SUPER_ADMIN tenant
  console.log('Step 2: Creating SUPER_ADMIN tenant...');
  let superAdminTenant = await prisma.tenant.findFirst({
    where: { slug: 'platform-admin' },
  });

  if (!superAdminTenant) {
    superAdminTenant = await prisma.tenant.create({
      data: {
        name: 'Platform Administration',
        slug: 'platform-admin',
        isActive: true,
      },
    });
    console.log('✓ SUPER_ADMIN tenant created:', superAdminTenant.id);
  } else {
    console.log('✓ SUPER_ADMIN tenant already exists:', superAdminTenant.id);
  }

  // Step 3: Create SUPER_ADMIN user
  console.log('\nStep 3: Creating SUPER_ADMIN user...');
  const superAdminEmail = 'admin@players-platform.com';
  let superAdminUser = await prisma.user.findUnique({
    where: {
      tenantId_email: {
        tenantId: superAdminTenant.id,
        email: superAdminEmail,
      },
    },
  });

  // No password: members sign in at the identity provider (0.1.6).
  if (!superAdminUser) {
    superAdminUser = await prisma.user.create({
      data: {
        email: superAdminEmail,
        role: UserRole.SUPER_ADMIN,
        firstName: 'Platform',
        lastName: 'Administrator',
        tenantId: superAdminTenant.id,
        isActive: true,
      },
    });
    console.log('✓ SUPER_ADMIN user created:', superAdminUser.id);
  } else {
    console.log('✓ SUPER_ADMIN user already exists:', superAdminUser.email);
  }

  // Step 4: Create sample tenants for testing
  console.log('\nStep 4: Creating sample tenants...');

  const sampleTenants = [
    {
      name: 'Manchester United FC',
      slug: 'manchester-united',
      domain: 'manutd.players-platform.com',
    },
    {
      name: 'Real Madrid Academy',
      slug: 'real-madrid-academy',
      domain: 'realmadrid.players-platform.com',
    },
    {
      name: 'Barcelona Youth Club',
      slug: 'barcelona-youth',
      domain: 'barca-youth.players-platform.com',
    },
  ];

  for (const tenantData of sampleTenants) {
    let tenant = await prisma.tenant.findUnique({
      where: { slug: tenantData.slug },
    });

    if (!tenant) {
      tenant = await prisma.tenant.create({
        data: tenantData,
      });
      console.log(`✓ Created tenant: ${tenant.name} (${tenant.id})`);
    } else {
      console.log(`✓ Tenant already exists: ${tenant.name}`);
    }

    // Create an admin user for each tenant
    const adminEmail = `admin@${tenant.slug}.com`;
    const existingAdmin = await prisma.user.findUnique({
      where: {
        tenantId_email: {
          tenantId: tenant.id,
          email: adminEmail,
        },
      },
    });

    if (!existingAdmin) {
      const admin = await prisma.user.create({
        data: {
          email: adminEmail,
          role: UserRole.ADMIN,
          firstName: 'Club',
          lastName: 'Administrator',
          tenantId: tenant.id,
          isActive: true,
        },
      });
      console.log(`  ✓ Created admin user: ${admin.id}`);
    }
  }

  console.log('\n=== Seeding Complete ===');
  console.log(`SUPER_ADMIN tenant: ${superAdminTenant.id}`);
  console.log(
    'Members sign in at the identity provider; the seed creates no password.',
  );

  await app.close();
}

bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
