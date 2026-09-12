//! The licence server's own pieces, kept in a library so the service, the
//! one-off import tool and the tests share exactly one definition of the
//! rules a licence lives by.

pub mod auth;
pub mod db;
pub mod extract;
pub mod gate;
pub mod importer;
pub mod model;
pub mod routes;
