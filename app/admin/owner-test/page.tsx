import {requireRole} from '@/lib/auth/session';import {Container} from '@/components/layout/primitives';export const dynamic='force-dynamic';// Test-only owner gate; replace in admin phase.
export default async function OwnerTest(){await requireRole('OWNER');return <Container><main id="main-content"><h1>Owner test</h1><p>Owner authorization verified.</p></main></Container>}
