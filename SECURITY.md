# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 2.x     | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email the maintainer directly at [versatiles@michael-kreil.de](mailto:versatiles@michael-kreil.de)
3. Include a detailed description of the vulnerability and steps to reproduce
4. Allow reasonable time for a response and fix before public disclosure

We aim to respond to security reports within 48 hours and will work with you to understand and address the issue promptly.

## Security Practices

This project follows these security practices:

- **Dependency auditing**: `npm audit` runs on every CI build to detect known vulnerabilities in dependencies
- **Minimal dependencies**: We keep production dependencies minimal to reduce attack surface
- **Code review**: All changes go through code review before merging
- **Automated testing**: Comprehensive test suite runs on every commit

## Dependency Updates

We use Dependabot to automatically create pull requests for dependency updates, including security patches. Critical security updates are prioritized and merged promptly.
