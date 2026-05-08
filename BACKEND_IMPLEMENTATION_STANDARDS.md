# Backend Implementation Standards Prompt Template

Copy and paste this prompt **before** your feature request to ensure standardized implementation.

---

## CONTEXT: Players Platform Backend Architecture

You are implementing a new feature for a NestJS backend following Clean Architecture with DDD principles.

## PROJECT ARCHITECTURE CONSTRAINTS (MANDATORY)

### 1. Layered Architecture Structure
Every module MUST follow this exact structure:
```
module-name/
├── application/
│   ├── use-cases/        # Business logic orchestration
│   └── services/         # Application-level services
├── domain/
│   ├── entities/         # Pure business objects (no dependencies)
│   └── interfaces/       # Repository interfaces (ports)
├── infrastructure/
│   ├── repositories/     # Data access implementations (adapters)
│   └── strategies/       # Auth strategies (if applicable)
├── presentation/
│   ├── dto/             # Request validation objects
│   ├── responses/       # Response models (optional)
│   └── *.controller.ts  # HTTP/WebSocket endpoints
└── *.module.ts          # Module definition & DI wiring
```

### 2. Dependency Rule (STRICT)
- **Presentation** → depends on → **Application**
- **Application** → depends on → **Domain** + **Infrastructure Interfaces**
- **Domain** → depends on → **NOTHING** (pure business logic)
- **Infrastructure** → implements → **Domain Interfaces**

NEVER violate this flow (e.g., Domain cannot import from Infrastructure)

### 3. Multi-Tenancy (CRITICAL)
- ALL models have `tenantId` field
- Prisma middleware automatically injects `tenantId` from AsyncLocalStorage
- NEVER manually add `tenantId` to queries - it's automatic
- Extract tenant from request: `req.tenantId` (set by TenantGuard)
- Use `PrismaService.runWithTenant(tenantId, fn)` only when needed

### 4. Authentication & Authorization
- Global JWT guard protects ALL routes by default
- Use `@Public()` decorator for auth endpoints (login, register)
- Use `@Roles(UserRole.ADMIN, UserRole.OWNER)` for role-based access
- Available roles: OWNER, ADMIN, LEGAL, COACH, MEDICAL, TRAINING_MANAGER, SCOUT, PLAYER
- Extract user from request: `req.user` (set by JwtAuthGuard)

### 5. Request Flow Pattern
```
HTTP Request 
  → Global Middleware (Helmet, CORS, Compression)
  → TenantGuard (extracts X-Tenant-ID header)
  → JwtAuthGuard (validates JWT token)
  → RolesGuard (checks @Roles decorator)
  → ValidationPipe (validates DTO with class-validator)
  → Controller (thin, delegates to use case)
  → Use Case (business logic orchestration)
  → Repository Interface (domain port)
  → Repository Implementation (Prisma adapter)
  → Prisma Service (auto-injects tenantId via middleware)
  → Database
  ← Response flows back through layers
  → TransformInterceptor (wraps in {statusCode, message, data, timestamp})
  ← HTTP Response
```

### 6. Repository Pattern (MANDATORY)
- Define interface in `domain/interfaces/`
- Implement in `infrastructure/repositories/`
- Inject interface (not implementation) in use cases

### 7. Use Case Pattern (MANDATORY)
- Each use case is a single class with `execute()` method
- One use case per operation (CreatePlayer, GetPlayer, UpdatePlayer, DeletePlayer)
- Use cases handle business rules, transactions, and domain events
- Controllers ONLY call use cases (no business logic in controllers)

### 8. DTO Validation (MANDATORY)
- Use `class-validator` decorators in DTOs
- Enable `whitelist: true` and `forbidNonWhitelisted: true` (already configured globally)
- All controller parameters must be validated DTOs

### 9. Response Format (AUTOMATIC)
- TransformInterceptor wraps all responses:
```json
{
  "statusCode": 201,
  "message": "Success",
  "data": { },
  "timestamp": "2026-05-06T12:00:00.000Z"
}
```
- NEVER manually format responses in controllers

### 10. Error Handling (AUTOMATIC)
- HttpExceptionFilter catches all exceptions
- Throw NestJS built-in exceptions:
  - `UnauthorizedException` - Invalid credentials/token
  - `ForbiddenException` - Insufficient permissions
  - `NotFoundException` - Resource not found
  - `ConflictException` - Duplicate resource
  - `BadRequestException` - Invalid input

### 11. Domain Events (PREFERRED for cross-module communication)
- Use `EventEmitter2` for decoupled communication
- Emit events in use cases after successful operations
- Listen in other modules' event listeners

### 12. Database Schema Changes
- Add models to `prisma/schema.prisma`
- ALWAYS include `tenantId String @db.Uuid` field
- ALWAYS add `@@unique([id, tenantId])` composite unique constraint
- ALWAYS add `@@index([tenantId])` and relevant indexes
- Use soft deletes: `deletedAt DateTime?`
- Run: `npx prisma migrate dev --name <description>` then `npx prisma generate`

### 13. Swagger Documentation (REQUIRED)
- Add `@ApiTags('Module Name')` to controllers
- Add `@ApiOperation({ summary: '...' })` to each endpoint
- Add `@ApiResponse({ status: 201, description: '...' })` for responses
- DTOs auto-documented via class-validator decorators

### 14. Module Registration
- Create module file: `*.module.ts`
- Register providers with dependency injection
- Export repositories if other modules need them
- Import module in `app.module.ts`

### 15. File Naming Conventions
- Use cases: `<action>-<entity>.usecase.ts` (e.g., `create-player.usecase.ts`)
- Repositories: `<entity>.repository.ts`
- Controllers: `<entities>.controller.ts` (plural)
- DTOs: `<action>-<entity>.dto.ts` (e.g., `create-player.dto.ts`)
- Entities: `<entity>.entity.ts`
- Interfaces: `<entity>-repository.interface.ts`

---

## IMPLEMENTATION CHECKLIST (Verify Before Submitting Code)

### Database Layer
- [ ] Added model to `prisma/schema.prisma` with `tenantId` field
- [ ] Added composite unique constraint `@@unique([id, tenantId])`
- [ ] Added appropriate indexes `@@index([tenantId])`
- [ ] Ran migration and generated Prisma client
- [ ] Used proper relation fields with tenantId references

### Domain Layer
- [ ] Created entity class in `domain/entities/`
- [ ] Defined repository interface in `domain/interfaces/`
- [ ] Entity has NO external dependencies (pure TypeScript)

### Infrastructure Layer
- [ ] Implemented repository in `infrastructure/repositories/`
- [ ] Repository implements domain interface
- [ ] Uses PrismaService for database operations
- [ ] Does NOT manually add `tenantId` to queries (middleware handles it)
- [ ] Maps Prisma models to domain entities

### Application Layer
- [ ] Created use case(s) in `application/use-cases/`
- [ ] Each use case has single `execute()` method
- [ ] Use case injects repository INTERFACE (not implementation)
- [ ] Business logic is in use case, NOT in controller
- [ ] Emits domain events if other modules need to react

### Presentation Layer
- [ ] Created DTOs with `class-validator` decorators
- [ ] Created controller with thin methods (delegate to use cases)
- [ ] Added `@ApiTags()` and `@ApiOperation()` for Swagger
- [ ] Added `@Roles()` decorator for authorization
- [ ] Uses `@Req() req: RequestWithUser` to get `tenantId` and `user`
- [ ] Returns use case result directly (TransformInterceptor wraps it)

### Module Wiring
- [ ] Created module file with proper providers array
- [ ] Provided repository interface with implementation class
- [ ] Exported repository if needed by other modules
- [ ] Imported module in `app.module.ts`

### Security & Best Practices
- [ ] Route is protected by default (no `@Public()` unless auth endpoint)
- [ ] Role-based access control applied (`@Roles()`)
- [ ] Input validation via DTO decorators
- [ ] No business logic in controllers
- [ ] No direct Prisma calls in use cases (use repositories)
- [ ] Consistent error handling (throw NestJS exceptions)
- [ ] Followed naming conventions

---

## COMMON MISTAKES TO AVOID

- DON'T put business logic in controllers
- DON'T call Prisma directly in use cases (use repositories)
- DON'T manually add `tenantId` to queries (middleware does it)
- DON'T inject repository implementation (inject interface)
- DON'T skip DTO validation decorators
- DON'T forget `@Roles()` decorator
- DON'T create circular dependencies between modules (use events instead)
- DON'T hardcode tenantId (always use `req.tenantId`)
- DON'T return custom response format (TransformInterceptor handles it)
- DON'T forget to add module to `app.module.ts` imports

---

## FEATURE REQUEST TEMPLATE

Now implement the following feature following ALL constraints above:

**Feature Name:** [Describe the feature]

**Requirements:**
- [List functional requirements]

**Database Changes:**
- [Describe new models or modifications]

**API Endpoints:**
- [List endpoints with HTTP methods, paths, and purpose]

**Business Rules:**
- [List validation rules, constraints, workflows]

**Expected Behavior:**
- [Describe what happens step-by-step]

---

## DELIVERABLES REQUIRED

Provide complete implementation including:

1. **Prisma Schema Changes** (if any)
2. **Domain Layer:**
   - Entity class
   - Repository interface
3. **Infrastructure Layer:**
   - Repository implementation
4. **Application Layer:**
   - Use case(s) with full business logic
5. **Presentation Layer:**
   - DTOs with validation
   - Controller with Swagger docs
6. **Module Definition:**
   - Module file with DI configuration
7. **App Module Update:**
   - Import statement for app.module.ts

Each file should be production-ready with proper TypeScript types, error handling, and comments explaining complex logic.

---

## VERIFICATION QUESTIONS

After implementation, answer these questions:

1. Does every layer only depend on allowed layers? (Check dependency rule)
2. Is tenant isolation automatic via middleware? (No manual tenantId in queries)
3. Are controllers thin (only delegate to use cases)?
4. Are use cases injecting repository interfaces (not implementations)?
5. Are all DTOs validated with class-validator decorators?
6. Are routes protected with appropriate @Roles() decorators?
7. Are domain events emitted for cross-module communication?
8. Is the module registered in app.module.ts?
9. Does the implementation follow the exact folder structure?
10. Are Swagger annotations present on all endpoints?

If any answer is NO, fix before submitting.
